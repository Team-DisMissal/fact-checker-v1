/* global __firebase_config __app_id __initial_auth_token */
import React, { useState, useCallback, useMemo, useEffect } from 'react';

// --- FIREBASE IMPORTS for Persistence ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, deleteDoc, onSnapshot, collection, query, orderBy, serverTimestamp } from 'firebase/firestore';

// --- Global Constants (Must be defined outside the component) ---
// Note: apiKey is left empty as per instructions, it is expected to be provided at runtime.
const apiKey = ""; 
// NOTE: Using a specific model to ensure the JSON structure is reliable
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
const MAX_RETRIES = 5;
const BASE_DELAY = 1000;

// --- Utility Functions ---

/**
 * Cleans up a URL to be used in search queries.
 * @param {string} url - The URL string.
 * @returns {string} The cleaned domain name.
 */
const cleanUrl = (url) => {
    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        return parsed.hostname.replace('www.', '');
    } catch {
        return url;
    }
};

/**
 * Generic function to safely handle API calls with exponential backoff.
 */
async function fetchWithBackoff(payload, attempt = 0) {
    const delay = BASE_DELAY * Math.pow(2, attempt);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': payload.generationConfig?.responseMimeType === "application/json" 
                    ? 'application/json' 
                    : 'application/json' 
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            if (response.status === 429 && attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, delay));
                return fetchWithBackoff(payload, attempt + 1);
            }
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        return response.json();
    } catch (error) {
        if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithBackoff(payload, attempt + 1);
        }
        console.error("Failed to fetch from API after multiple retries:", error);
        throw new Error("Failed to communicate with the API after multiple retries.");
    }
}



// --- Main React Component ---

const initialReport = { percentage: 0, status: '', justification: '' };
const initialContext = { text: '', sources: [] };

export default function App() {
    const [url, setUrl] = useState('');
    // appState: 'initial' | 'loading' | 'context' | 'complete' | 'error'
    const [appState, setAppState] = useState('initial');
    const [loadingText, setLoadingText] = useState('...');
    const [contextResults, setContextResults] = useState(initialContext);
    const [finalReport, setFinalReport] = useState(initialReport);
    const [errorMessage, setErrorMessage] = useState('');

    // --- History & Firebase State ---
    const [history, setHistory] = useState([]); 
    const [isAuthReady, setIsAuthReady] = useState(false); 
    const [db, setDb] = useState(null); 
    const [userId, setUserId] = useState(null); 
    const [isHistoryOpen, setIsHistoryOpen] = useState(false); // Default to closed now
    
    // --- Firebase Initialization and Auth ---
    useEffect(() => {
        if (typeof __firebase_config === 'undefined' || typeof __app_id === 'undefined') {
            console.error("Firebase configuration variables are missing.");
            setErrorMessage("App configuration is missing. History saving disabled.");
            return;
        }

    const firebaseConfig = JSON.parse(__firebase_config);
        const app = initializeApp(firebaseConfig);
        const firestoreDb = getFirestore(app);
        const firebaseAuth = getAuth(app);
        
    setDb(firestoreDb);

        const authCleanup = onAuthStateChanged(firebaseAuth, async (user) => {
            if (!user) {
                // If not signed in yet, use the custom token or sign in anonymously
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    try {
                        await signInWithCustomToken(firebaseAuth, __initial_auth_token);
                    } catch (err) {
                        console.error("Custom token sign-in failed:", err);
                        await signInAnonymously(firebaseAuth);
                    }
                } else {
                    await signInAnonymously(firebaseAuth);
                }
            }
            const currentUserId = firebaseAuth.currentUser?.uid || 'anonymous';
            setUserId(currentUserId);
            setIsAuthReady(true);
        });

        return () => authCleanup();
    }, []);

    // --- History Listener (Fetches real-time reports) ---
    useEffect(() => {
        if (!db || !isAuthReady || !userId) return;

        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        // Private Data Path: /artifacts/{appId}/users/{userId}/credibility_reports
        const reportsCollectionPath = `/artifacts/${appId}/users/${userId}/credibility_reports`;
        // Order by timestamp, descending
        const q = query(collection(db, reportsCollectionPath), orderBy('timestamp', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const reports = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setHistory(reports);
        }, (error) => {
            console.error("Firestore error loading history:", error);
            // Don't show critical error for history load, just log
        });

        return () => unsubscribe();
    }, [db, isAuthReady, userId]); 

    // --- Core Functions ---

    const resetApp = useCallback(() => {
        setUrl('');
        setAppState('initial');
        setLoadingText('...');
        setContextResults(initialContext);
        setFinalReport(initialReport);
        setErrorMessage('');
    }, []);

    const getScoreColor = useMemo(() => {
        if (finalReport.percentage >= 80) return 'high';
        if (finalReport.percentage >= 40) return 'medium';
        return 'low';
    }, [finalReport.percentage]);

    const loadReportFromHistory = useCallback((report) => {
        setAppState('complete');
        setErrorMessage('');
        setUrl(report.url);
        setFinalReport({
            percentage: report.percentage,
            status: report.status,
            justification: report.justification,
        });
        setContextResults({
            text: report.contextText,
            sources: report.contextSources || [],
        });
        // Close history drawer after loading report
        setIsHistoryOpen(false); 
    }, []);

    const saveReport = useCallback(async (reportData) => {
        if (!db || !userId) return;

        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const reportsCollectionPath = `/artifacts/${appId}/users/${userId}/credibility_reports`;
        
        try {
            // Generates a unique document ID
            const newDocRef = doc(collection(db, reportsCollectionPath)); 
            await setDoc(newDocRef, {
                ...reportData,
                timestamp: serverTimestamp(),
                userId: userId,
            });
        } catch (e) {
            console.error("Error adding document to Firestore: ", e);
        }
    }, [db, userId]);

    /**
     * Deletes a report from Firestore history.
     * @param {string} id - The document ID of the report to delete.
     * @param {object} e - The event object to stop propagation.
     */
    const deleteReport = useCallback(async (id, e) => {
        e.stopPropagation(); // Prevent the parent <li> click event from loading the report

        if (!db || !userId || !id) return;

        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const reportsCollectionPath = `/artifacts/${appId}/users/${userId}/credibility_reports`;
        
        try {
            await deleteDoc(doc(db, reportsCollectionPath, id));
        } catch (e) {
            console.error("Error deleting document from Firestore: ", e);
            setErrorMessage("Failed to delete the report. Please try again.");
        }
    }, [db, userId]);


    const checkCredibility = useCallback(async () => {
        if (!url.trim()) {
            setErrorMessage("Please enter a valid website URL.");
            return;
        }

        setAppState('loading');
        setErrorMessage('');
        setContextResults(initialContext);
        setFinalReport(initialReport);

        const cleanedDomain = cleanUrl(url);

        // --- STEP 1: Contextual Search (Fact Check Grounding) ---
        setLoadingText('Checking source context and reputation via Google Search for official fact-checks...');
        
        const contextSearchQuery = `Find official fact-checks from organizations like Poynter, Snopes, or the Google Fact Check Explorer, and any high-reputation media bias ratings (like Ad Fontes) for the source domain or recent claims made by: ${cleanedDomain}.`;

        const contextPayload = {
            contents: [{ parts: [{ text: contextSearchQuery }] }],
            tools: [{ "google_search": {} }],
            systemInstruction: {
                parts: [{ text: "You are an academic librarian specializing in critical information literacy. Based on the search results, provide a comprehensive summary (2-3 paragraphs) regarding the source's reputation, known academic standing, institutional biases, and any confirmed fact-check history. Be critical and objective." }]
            },
        };

        let currentContext = initialContext;

        try {
            const contextResult = await fetchWithBackoff(contextPayload);
            const contextText = contextResult.candidates?.[0]?.content?.parts?.[0]?.text || "Could could not retrieve specific context for this URL.";
            
            let sources = [];
            const groundingMetadata = contextResult.candidates?.[0]?.groundingMetadata;
            if (groundingMetadata && groundingMetadata.groundingAttributions) {
                sources = groundingMetadata.groundingAttributions
                    .filter(attr => attr.web?.uri && attr.web?.title)
                    .map(attr => ({ uri: attr.web.uri, title: attr.web.title }));
            }
            
            currentContext = { text: contextText, sources };
            setContextResults(currentContext);

        } catch (error) {
            console.error("Context Search Error:", error);
            setAppState('error');
            setErrorMessage(`Failed to retrieve contextual information. Error: ${error.message}`);
            return;
        }


        // --- STEP 2: Automatic CRAAP Analysis ---
        setAppState('context'); 
        setLoadingText('Performing academic CRAAP analysis and generating score...');

        const analysisPrompt = `Given the website domain: ${cleanedDomain}, and the following contextual information, perform a thorough CRAAP test evaluation. Assign a score out of 100 based on the total CRAAP criteria.
        
        **CRAAP Criteria:**
        - Currency: Timeliness (Is it recent/updated enough?)
        - Relevance: Importance for typical research (Is it appropriate for a general audience?)
        - Authority: Source of Information (Who is the author/publisher? What are their credentials?)
        - Accuracy: Reliability and truthfulness (Is it supported by evidence? Can it be verified? CONSIDER FACT-CHECK FINDINGS.)
        - Purpose: Reason information exists (To inform, persuade, sell? Is there bias?)
        
        **Contextual Search Results (Includes fact-check data):**
        ${currentContext.text}
        
        Based *only* on the context above, output the total percentage, the resulting status, and a detailed paragraph of justification that explains the score across the five CRAAP criteria.`;


        const analysisPayload = {
            contents: [{ parts: [{ text: analysisPrompt }] }],
            generationConfig: {
                temperature: 0.1, 
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "percentage": { "type": "NUMBER", "description": "The final credibility score out of 100." },
                        "status": { "type": "STRING", "description": "The final credibility rating (e.g., 'Low Credibility', 'Generally Credible', 'Highly Credible')." },
                        "justification": { "type": "STRING", "description": "A detailed paragraph explaining the CRAAP score breakdown across the 5 criteria and why the final status was assigned." }
                    },
                    "propertyOrdering": ["percentage", "status", "justification"]
                }
            },
            systemInstruction: {
                parts: [{ text: "You are a doctoral-level academic evaluator specializing in the CRAAP methodology. Based ONLY on the provided context, generate a JSON object containing the CRAAP analysis results. In your justification, prioritize academic evidence (peer-review, institutional backing, citation history, AND fact-check findings) to determine the score. The final percentage must be an integer." }]
            },
        };
        
        try {
            const result = await fetchWithBackoff(analysisPayload);
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (jsonText) {
                const parsedJson = JSON.parse(jsonText);
                const generatedReport = {
                    percentage: parsedJson.percentage || 0,
                    status: parsedJson.status || "Unknown Credibility",
                    justification: parsedJson.justification || "Could not generate detailed justification."
                };
                setFinalReport(generatedReport);
                
                // SAVE THE REPORT TO FIRESTORE
                saveReport({
                    url: cleanedDomain,
                    ...generatedReport,
                    contextText: currentContext.text,
                    contextSources: currentContext.sources,
                });
            }
            setAppState('complete');
            
        } catch (error) {
            console.error("Analysis Error:", error);
            setAppState('error');
            setErrorMessage(`Failed to complete the analysis. Error: ${error.message}`);
        }

    }, [url, saveReport]);


    // --- JSX Rendering Helpers ---

    const renderCta = () => (
        <div className="text-center text-white mt-8 mb-8 opacity-90">
            <h3 className="text-xl font-semibold mb-3">Ready to Check Website Credibility?</h3>
            <p className="text-base">Enter a website URL above to analyze its credibility using the comprehensive CRAAP Test methodology. Get detailed insights on currency, relevance, authority, accuracy, and purpose.</p>
        </div>
    );

    const renderLoading = () => (
        <div className="w-full max-w-xl text-center p-8 mt-8 mb-8 bg-white bg-opacity-95 rounded-xl shadow-2xl text-gray-800 border-t-4 border-blue-600">
            <div className="animate-spin inline-block w-10 h-10 border-4 border-t-blue-700 border-blue-200 rounded-full mb-4"></div>
            <p className="text-lg font-medium mb-1 text-blue-800">{loadingText}</p>
            <p className="text-sm text-gray-600">
                Please wait while we check and analyze your source.
            </p>
        </div>
    );

    const renderContext = () => (
        <div className="w-full max-w-xl content-box text-gray-800">
            <h2 className="text-2xl font-bold mb-4 border-b pb-2">Contextual Check Results</h2>
            <div className="scroll-container max-h-80 overflow-y-auto p-4 border border-gray-300 rounded-lg bg-gray-50 text-base">
                <p className="whitespace-pre-wrap leading-relaxed">{contextResults.text}</p>
                {contextResults.sources.length > 0 && (
                    <>
                        <h4 className="text-sm font-semibold mt-4 mb-2 text-gray-700 border-t pt-2">Sources Used:</h4>
                        <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                            {contextResults.sources.map((source, index) => (
                                <li key={index}>
                                    <a href={source.uri} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline transition">
                                        {source.title}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </div>
    );

    const renderFinalResult = () => (
        <div className="w-full max-w-xl content-box text-gray-800">
            <h2 className="text-2xl font-bold mb-6 border-b pb-2">Final Credibility Report</h2>
            <div className={`score-box p-4 rounded-xl text-center mb-6 ${getScoreColor}`}>
                <p className="text-lg font-medium text-gray-700 mb-2">Automated Credibility Score:</p>
                <h3 className="text-6xl font-extrabold mb-3">{finalReport.percentage}%</h3>
                <p className="text-2xl font-semibold text-gray-800">{finalReport.status}</p>
            </div>
            
            <div className="mt-8">
                <h4 className="text-xl font-bold mb-4">Detailed CRAAP Justification:</h4>
                <div className="p-3 bg-gray-100 rounded-lg border text-gray-700 whitespace-pre-wrap leading-relaxed text-base">
                    {finalReport.justification}
                </div>
            </div>
        </div>
    );
    
    // --- NEW: Navigation Bar Component ---
    const renderNavBar = () => (
        // Removed bg-gray-800 and shadow-lg for a completely transparent look
        <nav className="fixed top-0 left-0 w-full h-20 z-50 flex items-center justify-between px-4 sm:px-10">
            {/* Added 'font-baloo' class to apply the custom font */}
            <div className="text-2xl font-extrabold text-white tracking-wider font-baloo">
                DisMissal
            </div>
            {/* The hamburger button is now conditionally rendered based on isHistoryOpen */}
            {!isHistoryOpen && (
                <button
                    onClick={() => setIsHistoryOpen(prev => !prev)}
                    className="text-white hover:text-green-400 p-2 rounded transition"
                    aria-label="Toggle Analysis History"
                >
                    {/* Hamburger Icon (3 lines) */}
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="3" y1="12" x2="21" y2="12"></line>
                        <line x1="3" y1="6" x2="21" y2="6"></line>
                        <line x1="3" y1="18" x2="21" y2="18"></line>
                    </svg>
                </button>
            )}
        </nav>
    );

    // --- History Drawer Component (Refactored) ---
    const renderHistorySidebar = () => {
        const drawerWidthClass = 'sm:w-80'; // 320px on small screens and up

        return (
            <>
                {/* Overlay for darkening the background when drawer is open */}
                <div
                    className={`fixed inset-0 bg-black transition-opacity duration-300 z-30 ${isHistoryOpen ? 'opacity-50 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
                    onClick={() => setIsHistoryOpen(false)}
                ></div>

                {/* Drawer Container */}
                <aside
                    className={`fixed top-0 right-0 h-full w-full ${drawerWidthClass} bg-gray-50 shadow-2xl z-40 text-gray-800 transition-transform duration-300 ease-in-out overflow-y-auto`}
                    style={{
                        transform: isHistoryOpen ? 'translateX(0)' : 'translateX(100%)',
                    }}
                >
                    {/* Header with Close Button (Fixed within the drawer) */}
                    <div className="flex items-center justify-between border-b pb-2 absolute top-0 left-0 right-0 h-20 bg-gray-100 px-6 z-50">
                        <h2 className="text-xl font-extrabold text-gray-900 flex items-center">
                            <span className="text-green-600 mr-2 flex-shrink-0">
                                {/* SVG Icon for History */}
                                <svg xmlns="http://www.w3.org/2000/svg" className="inline w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10l4 4m-4-10a9 9 0 0 0-9 9m18 0a9 9 0 0 1-9 9"/></svg>
                            </span>
                            History
                        </h2>
                        <button
                            onClick={() => setIsHistoryOpen(false)}
                            // MODIFIED: Increased padding to p-3 for a significantly larger and more reliable touch target.
                            className="text-gray-600 hover:text-white hover:bg-red-500 p-3 rounded-full transition duration-150 cursor-pointer flex-shrink-0"
                            aria-label="Close History"
                            title="Close History"
                        >
                            {/* X icon */}
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>

                    {/* History List Content (Starts below the fixed drawer header) */}
                    <div className="history-content p-6" style={{ paddingTop: '5rem' }}>
                        {!isAuthReady && <p className="text-sm text-gray-500 italic">Connecting to database...</p>}

                        {isAuthReady && history.length === 0 && (
                            <div className="text-sm text-center p-4 bg-gray-100 rounded-lg text-gray-600">
                                Your analysis history will appear here after your first check.
                            </div>
                        )}

                        {isAuthReady && history.length > 0 && (
                            <ul className="space-y-3 max-h-[calc(100vh-10rem)] overflow-y-auto">
                                {history.map((report) => (
                                    <li 
                                        key={report.id} 
                                        onClick={() => loadReportFromHistory(report)}
                                        className="p-3 bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition duration-150 cursor-pointer flex flex-col"
                                    >
                                        {/* Flex container for URL and Delete Button */}
                                        <div className="flex justify-between items-start">
                                            <p className="text-sm font-semibold truncate text-blue-700 max-w-[80%]">
                                                {report.url}
                                            </p>
                                            {/* DELETE BUTTON */}
                                            <button
                                                // Stop propagation prevents the parent <li> click (loadReportFromHistory)
                                                onClick={(e) => deleteReport(report.id, e)} 
                                                className="ml-2 text-red-500 hover:text-red-700 transition duration-150 p-1 rounded-full hover:bg-red-100 flex-shrink-0"
                                                aria-label="Delete report"
                                                title="Delete Report"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6m4-6v6"/></svg>
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between mt-1 text-xs">
                                            <span className={`font-bold ${report.percentage >= 80 ? 'text-green-600' : report.percentage >= 40 ? 'text-yellow-600' : 'text-red-600'}`}>
                                                Score: {report.percentage}%
                                            </span>
                                            <span className="text-gray-500 ml-2">
                                                {report.timestamp ? new Date(report.timestamp.seconds * 1000).toLocaleDateString() : '...'}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </aside>
            </>
        );
    };

    const isProcessing = appState === 'loading' || appState === 'context';
    const isComplete = appState === 'complete' || appState === 'error';

    // --- Main Layout (Using flex-col structure now) ---
    return (
        <div className="min-h-screen relative" style={{
            fontFamily: 'Inter, sans-serif',
            background: '#F6F6F6' // Light background for the overall container
        }}>
            
            {/* Inject Google Font Link and Style Definition */}
            {/* This ensures the Baloo 2 font is available for the custom class */}
            <style dangerouslySetInnerHTML={{ __html: `
                @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&display=swap');
                .font-baloo {
                    font-family: 'Baloo 2', cursive;
                }
            `}} />

            {/* 1. Navigation Bar (Fixed at Top) */}
            {renderNavBar()}

            {/* 2. Main Content Area (Pushed down by the fixed navbar) */}
            <main className="pt-20 pb-10 flex flex-col items-center justify-start min-h-[calc(100vh-80px)] w-full" style={{
                background: 'linear-gradient(to bottom, #00A868, #F6F6F6)',
                color: '#ffffff'
            }}>
                
                <header className="mb-5 text-center px-4">
                    <h1 className="text-4xl font-extrabold text-white">Website Fact Checker</h1>
                    <p className="text-base text-white mt-4 opacity-90">Evaluate any source using the five pillars of critical thinking.</p>
                </header>

                {/* Input Section */}
                <div className="w-full max-w-xl bg-white rounded-full flex items-center p-1 mb-10 shadow-xl mx-4">
                    <input 
                        type="url" 
                        id="urlInput" 
                        placeholder="e.g. https://www.nasa.gov" 
                        value={url}
                        onChange={(e) => { setUrl(e.target.value); setErrorMessage(''); }}
                        disabled={isProcessing}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !isProcessing) checkCredibility(); }}
                        className="flex-grow px-4 py-3 text-gray-800 bg-transparent outline-none focus:ring-0 focus:border-transparent text-base" 
                    />
                    <button 
                        onClick={checkCredibility} 
                        disabled={isProcessing || !url.trim()}
                        className="px-6 py-3 bg-blue-700 text-white font-semibold rounded-full hover:bg-blue-800 transition duration-150 text-base disabled:bg-blue-400 flex-shrink-0 shadow-md"
                    >
                        {isProcessing ? 'Analyzing...' : 'Check'}
                    </button>
                </div>

                {errorMessage && (
                    <div className="w-full max-w-xl bg-red-100 text-red-700 p-4 rounded-lg mb-6 shadow-md text-base mx-4">
                        <p className="font-semibold">Error:</p>
                        <p>{errorMessage}</p>
                    </div>
                )}
                
                {/* Conditional Rendering based on State */}
                {appState === 'initial' && renderCta()}
                
                {(appState === 'loading' || appState === 'context') && renderLoading()}
                
                {appState === 'complete' && (
                    <>
                        {renderFinalResult()} 
                        <div className="h-6"></div> 
                        {renderContext()}
                    </>
                )}

                {/* Reset Button (Visible after first run) */}
                {isComplete && (
                    <button 
                        onClick={resetApp} 
                        className="mt-8 px-8 py-3 w-full max-w-xl bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition duration-150 text-lg shadow-lg mx-4"
                    >
                        Evaluate New Source
                    </button>
                )}

            </main>
            
            {/* 3. History Drawer (Fixed/Absolute Positioned) */}
            {renderHistorySidebar()}

        </div>
    );
}


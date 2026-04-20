import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import { findGameInLibrary } from './data/gameLibrary';

// ─── LANGUAGE CONFIG ──────────────────────────────────────────────────────────
const LANGUAGES = {
  en: { code: 'en', name: 'English', dir: 'ltr' },
};

const translations = {
  en: {
    appName: "GLITCH",
    chooseGameLabel: "What game are you playing?",
    chooseVibeLabel: "Vibe level:",
    startGameBtn: "Boot System",
    rulePlaceholder: "Waiting for command...",
    cardBackText: "GLITCH",
    autoModeActive: "AUTO: ON",
    autoModeInactive: "AUTO: OFF",
    recharging: "Recharging...",
    scanBoxLabel: "Scan Game Box 📸",
    scanRulebookLabel: "Scan Rulebook 📖",
    gameInputPlaceholder: "Search a board game...",
    loadingKnowledge: "Reading game...",
    loadingText: "Analyzing...",
    loadingMore: "Loading more...",
    scannedGame: "Scanned game",
    autoModeDesc: "System fires automatically every 45-90 seconds",
    lowConfidenceWarning: "Not enough game knowledge — upload the rulebook for sharper rules 📖",
    noKnowledgeWarning: "Game not in library — scan your rulebook so GLITCH can learn this game.",
    vibes: {
      chaotic: "Chaos 🔥",
      drinking: "Drinks 🍻",
      funny: "Family Party 🎉"
    },
    errors: {
      networkError: "Network hiccup",
      checkConnection: "Check your internet",
      tryAgain: "Give it another shot"
    }
  }
};

// ─── GAME KNOWLEDGE HELPERS ───────────────────────────────────────────────────
// gameKnowledge holds structured understanding of a real game.
// It is NOT a list of GLITCH rules — those are generated separately and never saved here.
//
// Priority order:
//   1. Internal library (seed knowledge, works offline, no network needed)
//   2. localStorage (user's previously extracted rulebook knowledge)
//   3. Rulebook image (Gemini vision extraction, saved to localStorage for reuse)
//   4. BGG minimal metadata (supplementary, non-critical)
//
// The internal library is the primary path. BGG is no longer required.

const normalizeGameKey = (gameName, gameId) => {
  if (gameId) return `lib_${gameId}`;
  return `name_${(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
};

const getStoredGameKnowledge = (gameKey) => {
  try {
    const raw = localStorage.getItem(`glitch_gk_${gameKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const saveStoredGameKnowledge = (gameKey, knowledge) => {
  // Browser-local memory only — not shared across devices or users.
  // Saves rulebook-extracted knowledge so the user doesn't need to re-upload next session.
  try {
    const data = JSON.stringify(knowledge);
    localStorage.setItem(`glitch_gk_${gameKey}`, data);
    // Also index by normalized game name so fuzzy lookup can find it regardless of
    // how the game was identified (library id vs BGG id vs free-typed name).
    if (knowledge.gameName) {
      const nameKey = `name_${knowledge.gameName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (`glitch_gk_${nameKey}` !== `glitch_gk_${gameKey}`) {
        localStorage.setItem(`glitch_gk_${nameKey}`, data);
      }
    }
  } catch { /* localStorage unavailable — non-critical */ }
};

// Scans all stored game knowledge entries for a name match when the direct key fails.
// Handles case differences, spacing, and minor naming variations across sessions.
// Browser-local only — this does not search any external database.
const findStoredKnowledgeByName = (searchName) => {
  try {
    const q = (searchName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (q.length < 2) return null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('glitch_gk_')) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        if (!data?.gameName) continue;
        const stored = data.gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (stored === q || stored.startsWith(q) || q.startsWith(stored)) return data;
      } catch { continue; }
    }
    return null;
  } catch { return null; }
};

const emptyKnowledge = () => ({
  gameId: null,
  gameName: '',
  sourceType: 'manual',    // 'seed' | 'rulebook_image' | 'bgg_minimal' | 'manual'
  confidence: 'low',        // 'high' | 'medium' | 'low'
  sourceLanguage: '',       // language the knowledge was extracted from (e.g. 'Hebrew')
  mechanics: [],
  vocabulary: [],           // game-specific nouns for authentic GLITCH rules
  actions: [],              // what players do — triggers for GLITCH overlays
  coreElements: [],         // board spaces, card types, pieces, resources
  mutableHooks: [],         // concrete moments safe to twist for one-round humor
  earlyGameHooks: [],       // subset of hooks relevant at game start (before mid/late development)
  ruleSummary: '',
  rawRuleText: '',
});

// Cached outside the component — model lookup runs once per page load, not per batch.
// Every call after the first returns immediately without a network round-trip.
let _modelCache = null;

// ─── STYLE HELPERS ────────────────────────────────────────────────────────────
const removeStyle = {
  position: 'absolute', top: 4, right: 4,
  background: 'rgba(0,0,0,0.85)', color: '#fff', border: 'none',
  borderRadius: '50%', width: 26, height: 26,
  cursor: 'pointer', fontSize: '0.9rem', fontWeight: 'bold', zIndex: 10,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const uploadBtnStyle = (color) => ({
  width: '100%', height: 72, padding: '10px',
  background: 'transparent', border: `1px dashed ${color}`,
  borderRadius: '8px', color, fontSize: '0.8rem', lineHeight: 1.3,
  cursor: 'pointer', transition: 'background 0.3s ease',
  display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
});

// ─── APP ──────────────────────────────────────────────────────────────────────
function App() {
  const API_KEY = process.env.REACT_APP_GEMINI_KEY;
  const [lang] = useState('en');
  const langConfig = LANGUAGES[lang];
  const t = translations[lang];

  // ── Screen ──
  const [screen, setScreen] = useState('home');

  // ── Search state ──
  // searchResults holds merged results: library entries first, then BGG results.
  // selectedGame carries source: 'library' | 'bgg' so loadGameKnowledge knows the path.
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
  const [bggMechanics, setBggMechanics] = useState('');
  const [isFetchingMechanics, setIsFetchingMechanics] = useState(false);
  const [fetchStatus, setFetchStatus] = useState('Idle');

  // ── Game knowledge state ──
  // Structured understanding of the real game — built before GLITCH rule generation.
  // Generated GLITCH rules are session-only and never written back here.
  const [gameKnowledge, setGameKnowledge] = useState(emptyKnowledge());
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [showWarning, setShowWarning] = useState(null); // null | 'low' | 'none'

  // ── Image state — two separate upload paths ──
  // Box image = weak visual identification hint only.
  // Rulebook image = primary source for rich rule knowledge extraction.
  const [boxImageData, setBoxImageData] = useState(null);
  const [rulebookImageData, setRulebookImageData] = useState(null);

  // ── Session/game-loop state ──
  const [vibeKey, setVibeKey] = useState('chaotic');
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [rulesQueue, setRulesQueue] = useState([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [currentRule, setCurrentRule] = useState('');

  // ── Refs ──
  const timerRef = useRef(null);
  const flipTimeoutRef = useRef(null);
  const cooldownTimerRef = useRef(null);
  const boxFileInputRef = useRef(null);
  const rulebookFileInputRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const queueRef = useRef([]);
  const isGeneratingRef = useRef(false);
  const gameKnowledgeRef = useRef(emptyKnowledge());
  const selectedGameRef = useRef(null);
  const searchTermRef = useRef('');
  const bggMechanicsRef = useRef('');
  const boxImageRef = useRef(null);
  const rulebookImageRef = useRef(null);
  const historyRef = useRef([]);

  // Keep refs in sync with state
  useEffect(() => { queueRef.current = rulesQueue; }, [rulesQueue]);
  useEffect(() => { gameKnowledgeRef.current = gameKnowledge; }, [gameKnowledge]);
  useEffect(() => { selectedGameRef.current = selectedGame; }, [selectedGame]);
  useEffect(() => { searchTermRef.current = searchTerm; }, [searchTerm]);
  useEffect(() => { bggMechanicsRef.current = bggMechanics; }, [bggMechanics]);
  useEffect(() => { boxImageRef.current = boxImageData; }, [boxImageData]);
  useEffect(() => { rulebookImageRef.current = rulebookImageData; }, [rulebookImageData]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target))
        setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ─── BGG PROXY ────────────────────────────────────────────────────────────
  // BGG is supplementary — the app works without it. If the proxy returns 502
  // (BGG blocked) or the network fails, local library results still appear.
  const proxyFetch = async (url) => {
    console.log('[GLITCH] proxyFetch →', url.slice(0, 100));
    const res = await fetch(`/api/bgg?url=${encodeURIComponent(url)}`);
    console.log('[GLITCH] proxyFetch status:', res.status);
    if (!res.ok) throw new Error('proxy status ' + res.status);
    const text = await res.text();
    if (text.includes('Unauthorized')) throw new Error('BGG blocked');
    return text;
  };

  // ─── BGG SEARCH ───────────────────────────────────────────────────────────
  const parseBGGSearch = (text) => {
    if (!text || text.length < 30 || text.includes('Unauthorized') || text.includes('<message>')) return [];
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    if (xml.querySelector('parsererror')) return [];

    const v2 = Array.from(xml.querySelectorAll('item[type="boardgame"], item')).slice(0, 8);
    if (v2.length > 0) {
      return v2.map(item => {
        const nameEl = item.querySelector('name[type="primary"]') || item.querySelector('name');
        const yearEl = item.querySelector('yearpublished');
        return {
          id: item.getAttribute('id'),
          name: nameEl?.getAttribute('value') || nameEl?.textContent?.trim() || 'Unknown',
          year: yearEl?.getAttribute('value') || '',
          source: 'bgg',
        };
      }).filter(r => r.name !== 'Unknown');
    }
    return Array.from(xml.querySelectorAll('boardgame')).slice(0, 8).map(item => {
      const nameEl = item.querySelector('name[primary="true"]') || item.querySelector('name');
      return {
        id: item.getAttribute('objectid'),
        name: nameEl?.textContent?.trim() || 'Unknown',
        year: item.querySelector('yearpublished')?.textContent?.trim() || '',
        source: 'bgg',
      };
    }).filter(r => r.name !== 'Unknown');
  };

  // searchBGG runs after the local library search completes.
  // It supplements local results — if BGG fails, local library results remain visible.
  // localResults are passed in so BGG results can be deduped and appended below.
  const searchBGG = useCallback(async (query, localResults = []) => {
    if (!query || query.trim().length < 2) return;
    console.log('[GLITCH] searchBGG started:', query);
    try {
      const text = await proxyFetch(
        `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`
      );
      const bggResults = parseBGGSearch(text);
      console.log('[GLITCH] searchBGG parsed:', bggResults.length, 'results');

      // Dedup: hide BGG results whose names are already in the local library list
      const localNames = new Set(localResults.map(r => r.name.toLowerCase()));
      const filteredBgg = bggResults.filter(r => !localNames.has(r.name.toLowerCase()));
      const merged = [...localResults, ...filteredBgg];

      setSearchResults(merged);
      setFetchStatus(merged.length > 0 ? 'Ok' : 'Empty');
    } catch (e) {
      console.warn('[GLITCH] searchBGG error (non-critical):', e.message);
      // BGG failed — keep showing local results, don't show an error if we have them
      if (localResults.length > 0) {
        setSearchResults(localResults);
        setFetchStatus('Ok');
      } else {
        setFetchStatus('Error');
      }
    }
  }, []);

  // Fetches BGG mechanic/category tags for BGG-selected games only.
  const fetchBGGMetadata = useCallback(async (gameId) => {
    if (!gameId) return;
    console.log('[GLITCH] fetchBGGMetadata started for gameId:', gameId);
    setIsFetchingMechanics(true);
    try {
      const text = await proxyFetch(
        `https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&stats=0`
      );
      const xml = new DOMParser().parseFromString(text, 'text/xml');
      const mechanics = Array.from(xml.querySelectorAll('link[type="boardgamemechanic"]'))
        .map(el => el.getAttribute('value')).filter(Boolean).slice(0, 8);
      const categories = Array.from(xml.querySelectorAll('link[type="boardgamecategory"]'))
        .map(el => el.getAttribute('value')).filter(Boolean).slice(0, 4);
      const combined = [...mechanics, ...categories].join(', ');
      setBggMechanics(combined);
      bggMechanicsRef.current = combined;
    } catch (e) {
      console.warn('[GLITCH] BGG metadata unavailable (non-critical):', e.message);
    } finally {
      setIsFetchingMechanics(false);
    }
  }, []);

  const handleSearchChange = useCallback((value) => {
    console.log('[GLITCH] handleSearchChange:', value);
    setSearchTerm(value);
    searchTermRef.current = value;
    setSelectedGame(null);
    selectedGameRef.current = null;
    setBggMechanics('');
    bggMechanicsRef.current = '';
    setShowWarning(null);
    setGameKnowledge(emptyKnowledge());
    gameKnowledgeRef.current = emptyKnowledge();

    if (!value || value.trim().length < 2) {
      setSearchResults([]);
      setShowDropdown(false);
      setFetchStatus('Idle');
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      return;
    }

    // Search the internal library immediately — synchronous, no network needed.
    // These results appear instantly and are the primary suggestion source.
    const libraryMatches = findGameInLibrary(value).map(entry => ({
      id: entry.id,
      name: entry.canonicalName,
      year: '',
      source: 'library',
      libraryEntry: entry,
    }));

    setSearchResults(libraryMatches);
    setShowDropdown(true);
    // Show Loading only if library has no matches (BGG may fill the gap)
    setFetchStatus(libraryMatches.length > 0 ? 'Ok' : 'Loading');

    // BGG fires after debounce as a supplementary source.
    // If BGG is blocked or slow, the library results are already visible.
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchBGG(value, libraryMatches), 500);
  }, [searchBGG]);

  const handleGameSelect = useCallback((game) => {
    console.log('[GLITCH] handleGameSelect:', game.name, '| source:', game.source, '| id:', game.id);
    setSelectedGame(game);
    selectedGameRef.current = game;
    setSearchTerm(game.name);
    searchTermRef.current = game.name;
    setShowDropdown(false);
    setShowWarning(null);
    // Library games carry full knowledge already — no BGG metadata fetch needed
    if (game.source === 'bgg') fetchBGGMetadata(game.id);
  }, [fetchBGGMetadata]);

  // ─── GEMINI MODEL SELECTION ───────────────────────────────────────────────
  const getBestModel = async () => {
    if (_modelCache) return _modelCache;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
      const data = await res.json();
      _modelCache = data.models?.find(m => m.name.includes('flash'))?.name
        || data.models?.find(m => m.name.includes('gemini-1.5-pro'))?.name
        || data.models?.[0]?.name
        || 'models/gemini-1.5-flash';
    } catch { _modelCache = 'models/gemini-1.5-flash'; }
    return _modelCache;
  };

  // ─── RULEBOOK KNOWLEDGE EXTRACTION ───────────────────────────────────────
  // Uses Gemini vision to read an actual rulebook image and extract structured knowledge.
  // This is the growth path for games not in the internal library.
  // The result is saved to localStorage so the user doesn't need to upload again.
  // This produces real game understanding — NOT a list of GLITCH rules.
  const extractKnowledgeFromRulebookImage = useCallback(async (imageData, gameName) => {
    const model = await getBestModel();
    const prompt = `You are a game analyst reading a photo of a board game rulebook or rules sheet.

Your job: extract structured knowledge about the REAL game rules visible in this image.
This is NOT for generating funny rules — it is for understanding how the actual game works.

Game name hint: "${gameName || 'unknown'}"

Return ONLY this JSON (no explanation, no markdown):
{
  "gameName": "exact game name from rulebook",
  "sourceLanguage": "language the rulebook is written in, e.g. 'English', 'Hebrew', 'Spanish'",
  "vocabulary": ["game-specific nouns visible in the text, e.g. 'sheriff', 'outlaw', 'property', 'district'"],
  "actions": ["things players can do, e.g. 'roll dice', 'draw card', 'place worker'"],
  "coreElements": ["board spaces, card types, pieces, resources, zones"],
  "mutableHooks": ["specific game moments that could be temporarily twisted for humor without breaking the game"],
  "earlyGameHooks": ["hooks relevant at game START only — setup, first turns, dealing cards, choosing roles"],
  "ruleSummary": "1-2 sentence plain English summary of how the game works",
  "rawRuleText": "key rule phrases or sentences readable directly from the image",
  "confidence": "high"
}

Constraints:
- Use only what is actually visible in the image
- Be specific — use this game's own terminology
- mutableHooks must be concrete game moments, not generic actions
- earlyGameHooks must be a subset of mutableHooks that only apply in the first few turns
- Return valid JSON only`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: imageData.split(',')[1] } }
          ]}],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_KEY]);

  // ─── GAME KNOWLEDGE PIPELINE ──────────────────────────────────────────────
  // Builds structured game knowledge before GLITCH rule generation.
  //
  // Priority order:
  //   A. Internal library   — instant, no network, primary path
  //   B. localStorage cache — previously extracted rulebook knowledge
  //   C. Rulebook image     — Gemini vision extraction, saved for future reuse
  //   D. BGG minimal        — secondary, only if a BGG game was selected
  //   E. Nothing            — caller shows warning, asks for rulebook upload
  //
  // Generated GLITCH rules are NEVER written here.
  const loadGameKnowledge = useCallback(async () => {
    const game = selectedGameRef.current;
    const name = game?.name || searchTermRef.current?.trim() || '';
    const gameId = game?.id || null;
    const gameKey = normalizeGameKey(name, gameId);
    const rulebookImg = rulebookImageRef.current;
    const bggMechanicsStr = bggMechanicsRef.current;

    setIsLoadingKnowledge(true);
    setShowWarning(null);

    // B-early. localStorage — check FIRST even for library games.
    //    Rulebook upload always overrides library seed knowledge.
    //    Also try fuzzy name scan if the direct key misses.
    const stored = getStoredGameKnowledge(gameKey)
      || findStoredKnowledgeByName(name);
    if (stored && (stored.confidence === 'high' || stored.confidence === 'medium')) {
      console.log('[GLITCH] loadGameKnowledge source: localStorage cache —', gameKey);
      setGameKnowledge(stored);
      gameKnowledgeRef.current = stored;
      setIsLoadingKnowledge(false);
      return stored;
    }

    // A. Internal library — the primary game knowledge source.
    //    No network access required. Works offline. Returns immediately.
    if (game?.source === 'library' && game.libraryEntry) {
      const entry = game.libraryEntry;
      console.log('[GLITCH] loadGameKnowledge source: internal library —', entry.canonicalName);
      const knowledge = {
        ...emptyKnowledge(),
        gameId: entry.id,
        gameName: entry.canonicalName,
        sourceType: 'seed',
        confidence: entry.confidence,
        mechanics: entry.mechanics || [],
        vocabulary: entry.vocabulary || [],
        actions: entry.actions || [],
        coreElements: entry.coreElements || [],
        mutableHooks: entry.mutableHooks || [],
        earlyGameHooks: entry.earlyGameHooks || [],
        ruleSummary: entry.ruleSummary,
      };
      setGameKnowledge(knowledge);
      gameKnowledgeRef.current = knowledge;
      setIsLoadingKnowledge(false);
      return knowledge;
    }

    console.log('[GLITCH] loadGameKnowledge — no library/cache match | rulebookImg:', !!rulebookImg);

    // C. Rulebook image — the growth path for games not in the internal library.
    //    Gemini reads the actual rule text. Knowledge is saved to localStorage
    //    so the user only needs to upload once per game.
    if (rulebookImg) {
      try {
        const extracted = await extractKnowledgeFromRulebookImage(rulebookImg, name);
        const knowledge = {
          ...emptyKnowledge(),
          gameId,
          gameName: extracted.gameName || name,
          sourceType: 'rulebook_image',
          confidence: extracted.confidence || 'high',
          sourceLanguage: extracted.sourceLanguage || '',
          vocabulary: extracted.vocabulary || [],
          actions: extracted.actions || [],
          coreElements: extracted.coreElements || [],
          mutableHooks: extracted.mutableHooks || [],
          earlyGameHooks: extracted.earlyGameHooks || [],
          ruleSummary: extracted.ruleSummary || '',
          rawRuleText: extracted.rawRuleText || '',
        };
        saveStoredGameKnowledge(gameKey, knowledge);
        setGameKnowledge(knowledge);
        gameKnowledgeRef.current = knowledge;
        setIsLoadingKnowledge(false);
        return knowledge;
      } catch (e) {
        console.warn('[GLITCH] Rulebook extraction failed, falling through:', e.message);
      }
    }

    // D. BGG minimal — secondary path, only when a BGG result was confirmed.
    //    Crowd-sourced mechanic tags are better than nothing but not rule text.
    //    The app works without BGG — this is never the critical path.
    if (game?.source === 'bgg') {
      const mechanicsArr = bggMechanicsStr ? bggMechanicsStr.split(', ').filter(Boolean) : [];
      const confidence = mechanicsArr.length >= 3 ? 'medium' : 'low';
      console.log('[GLITCH] loadGameKnowledge source: bgg_minimal | confidence:', confidence, '| mechanics:', mechanicsArr.length);
      const knowledge = {
        ...emptyKnowledge(),
        gameId,
        gameName: name,
        sourceType: 'bgg_minimal',
        confidence,
        mechanics: mechanicsArr,
        ruleSummary: mechanicsArr.length > 0
          ? `${name} — a game involving: ${mechanicsArr.slice(0, 4).join(', ')}.`
          : `${name} — board game.`,
      };
      if (confidence !== 'low') saveStoredGameKnowledge(gameKey, knowledge);
      setGameKnowledge(knowledge);
      gameKnowledgeRef.current = knowledge;
      setIsLoadingKnowledge(false);
      return knowledge;
    }

    // E. No usable knowledge — caller should show the rulebook upload prompt
    console.log('[GLITCH] loadGameKnowledge source: none — no library match, no image, no BGG');
    const none = { ...emptyKnowledge(), gameName: name, gameId };
    setGameKnowledge(none);
    gameKnowledgeRef.current = none;
    setIsLoadingKnowledge(false);
    return none;
  }, [extractKnowledgeFromRulebookImage]);

  // ─── GLITCH RULE GENERATION ───────────────────────────────────────────────
  // Builds the generation prompt using real gameKnowledge fields.
  // GLITCH rules are temporary one-round overlays — never stored as game knowledge.
  //
  // batchSize: 5 for the first (fast) batch, 10 for subsequent batches.
  // mutableHooks are formatted as an explicit trigger list so the model stays
  // phase-aware — rules must attach to a real moment, not invent new ones.
  // Language instruction ensures rules stay in the game's own language (e.g. Hebrew).
  const buildGlitchPrompt = (knowledge, vibeKey, history, batchSize = 10) => {
    const { gameName, vocabulary, actions, coreElements, mutableHooks, earlyGameHooks, ruleSummary, mechanics, confidence, sourceLanguage } = knowledge;
    const hasRichKnowledge = vocabulary.length > 0 || mutableHooks.length > 0;

    // Use earlyGameHooks as PRIORITY suggestions in the first few turns.
    // Never restrict to only early hooks — that limits the model to too few triggers.
    // Always include the full mutableHooks list; early hooks appear first as hints.
    const isEarlyGame = history.length < 5;
    let activeHooks;
    if (isEarlyGame && earlyGameHooks?.length > 0) {
      const earlySet = new Set(earlyGameHooks);
      activeHooks = [...earlyGameHooks, ...mutableHooks.filter(h => !earlySet.has(h))];
    } else {
      activeHooks = mutableHooks;
    }

    // Each vibe has: a tone description, an example style, and an anti-pattern to avoid.
    // Chaos is deliberately amplified — mild/safe twists are called out explicitly.
    // Family Party replaces Silly — still G-rated but more energetic and physical.
    const VIBES = {
      chaotic: {
        tone: 'TOTAL CHAOS. Invert, reverse, or steal. The twist should feel wrong, surprising, or absurd.',
        example: '"Roll dice? The player to your left moves instead." | "Pay rent? The owner pays YOU." | "Draw a card? Discard one from your hand first."',
        avoid: 'Do NOT write safe or mild twists. Chaos means the rule actively breaks or inverts what was about to happen.',
      },
      drinking: {
        tone: 'Party drinking game. Every twist makes someone drink. Be specific about WHO drinks and WHY.',
        example: '"Land on someone\'s property? Drink instead of paying." | "Draw a bad card? Two drinks, pass it on."',
        avoid: 'Do NOT just say "take a drink." Specify the exact trigger and who drinks.',
      },
      funny: {
        tone: 'Family party energy — safe for all ages but genuinely fun. Physical comedy, silly voices, unexpected social challenges.',
        example: '"Roll doubles? Do your best robot impression before moving." | "Lose a piece? Give it a dramatic name and eulogy." | "Take someone\'s card? Trade seats with them first."',
        avoid: 'Do NOT write boring or generic twists. Every rule should make the table laugh or groan.',
      },
    };

    const vibe = VIBES[vibeKey] || VIBES.funny;

    // mutableHooks formatted as an explicit trigger list.
    // The instruction "MUST attach to one of these" prevents the model from
    // inventing triggers that happen at the wrong phase of the game.
    const hookLabel = isEarlyGame && earlyGameHooks?.length > 0
      ? 'TRIGGER MOMENTS (★ = early-game priority)'
      : 'TRIGGER MOMENTS';
    const earlySet = new Set(earlyGameHooks || []);
    const triggerBlock = activeHooks.length > 0
      ? `${hookLabel} — pick from these real game moments:\n${activeHooks.map(h => `  ${earlySet.has(h) ? '★' : '•'} ${h}`).join('\n')}`
      : '';

    const gameContext = hasRichKnowledge
      ? `GAME: ${gameName}
HOW IT WORKS: ${ruleSummary}
GAME TERMS (use these — not generic board game words): ${vocabulary.join(', ')}
PLAYER ACTIONS: ${actions.slice(0, 8).join(' | ')}
CORE ELEMENTS: ${coreElements.join(', ')}
${triggerBlock}`
      : `GAME: ${gameName}
HOW IT WORKS: ${ruleSummary}
KNOWN MECHANICS: ${mechanics.join(', ')}`;

    const historyBlock = history.length > 0
      ? `\nALREADY USED — do not repeat:\n${history.slice(-15).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    const conservativeNote = confidence === 'medium'
      ? '\nNOTE: Limited knowledge — stay grounded in the game name and known mechanics only.'
      : '';

    // Output language: use the UI language (always match the player's session language).
    // sourceLanguage is the rulebook's language — used for knowledge extraction only, not output.
    const langNote = sourceLanguage && sourceLanguage.toLowerCase() !== 'english'
      ? `\nWRITE IN: English (the rulebook was in ${sourceLanguage}, but players need English output)`
      : '';

    return `You are GLITCH. You write temporary one-round rule overlays for board games.

${gameContext}

VIBE: ${vibe.tone}
EXAMPLE STYLE: ${vibe.example}
AVOID: ${vibe.avoid}

RULES FOR WRITING RULES:
1. Format: [trigger] + [twist]. Max 10 words total.
2. Trigger must be a real game moment (from the trigger list above if provided)
3. Twist must be ${vibeKey === 'chaotic' ? 'surprising, disruptive, or an outright inversion' : vibeKey === 'drinking' ? 'tied to drinking — specify who and why' : 'silly, physical, or a fun social challenge'}
4. Use this game's own vocabulary — not generic board game words
5. No emojis. No markdown. No explanations.
6. Return exactly ${batchSize} rules as a JSON array.${conservativeNote}${langNote}${historyBlock}

Return ONLY: ["rule 1", "rule 2", ...]`;
  };

  // ─── GENERATION HELPERS ───────────────────────────────────────────────────

  // Parses raw model text into a clean string array.
  // Handles: bare arrays, object-wrapped arrays {"rules":[...]}, partial JSON.
  const parseGeneratedRules = (rawText) => {
    const cleaned = (rawText || '').replace(/```json|```/g, '').trim();
    console.log('[GLITCH] parseGeneratedRules | raw length:', cleaned.length, '| preview:', cleaned.slice(0, 120));
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
      console.log('[GLITCH] JSON parse: success | type:', Array.isArray(parsed) ? 'array' : typeof parsed);
    } catch (e) {
      console.warn('[GLITCH] JSON parse: failed —', e.message);
      return [];
    }
    // If model wrapped the array in an object (e.g. {"rules": [...]})
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      const nested = Object.values(parsed).find(v => Array.isArray(v));
      if (nested) {
        console.log('[GLITCH] unwrapped object → array of length', nested.length);
        parsed = nested;
      } else {
        console.warn('[GLITCH] parsed object has no nested array — unusable');
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    const rules = parsed
      .map(item => (typeof item === 'string' ? item.trim() : item?.rule || Object.values(item || {})[0] || ''))
      .filter(r => typeof r === 'string' && r.length > 3 && r.length < 200);
    console.log('[GLITCH] cleaned rules:', rules.length, 'usable');
    return rules;
  };

  const isUsableRuleBatch = (rules, minCount = 3) => rules.length >= minCount;

  // Builds the minimal fallback prompt used when the main prompt fails.
  // Shorter, less strict, higher chance of getting a valid JSON array back.
  const buildFallbackPrompt = (knowledge, vibeKey, batchSize) => {
    const { gameName, vocabulary, ruleSummary } = knowledge;
    const vibeHint = vibeKey === 'chaotic' ? 'chaotic and surprising'
      : vibeKey === 'drinking' ? 'drinking game (say who drinks)'
      : 'funny and family-friendly';
    const terms = vocabulary.slice(0, 5).join(', ') || gameName;
    return `Write 5 short funny board game rule overlays for ${gameName}.
Style: ${vibeHint}. Use terms: ${terms}.
${ruleSummary ? `Game summary: ${ruleSummary}` : ''}
Format: short sentence, max 12 words. No emojis.
Return ONLY a JSON array: ["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]`;
  };

  // Sends one generation request to Gemini and returns parsed rules (may be empty).
  const runGenerationRequest = async (model, requestBody, label) => {
    console.log('[GLITCH] runGenerationRequest:', label);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
    console.log('[GLITCH] finishReason:', finishReason, '| raw length:', rawText.length);
    return parseGeneratedRules(rawText);
  };

  // generateGlitchRulesBatch: produces session-only GLITCH rules from game knowledge.
  // Input: real gameKnowledge from loadGameKnowledge.
  // Output: temporary rule strings — never saved as canonical knowledge.
  //
  // Reliability contract:
  //   1. Try main prompt. If result has < 3 usable rules, try fallback prompt once.
  //   2. Only add rules to the queue if >= 3 usable rules exist.
  //   3. Only switch to game screen (isInitial) if the queue actually has rules.
  //   4. If everything fails on initial load, show the error fallback — never a blank game.
  const generateGlitchRulesBatch = useCallback(async (isInitial = false, knowledgeOverride = null) => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    if (isInitial) setInitialLoading(true);

    const knowledge = knowledgeOverride || gameKnowledgeRef.current;
    const boxImg = boxImageRef.current;
    const rulebookImg = rulebookImageRef.current;
    const history = historyRef.current;
    const MIN_RULES = 3;

    try {
      const model = await getBestModel();

      // First batch is small (5 rules) so the first card appears faster.
      // Subsequent refill batches generate 10 for a deeper queue.
      const batchSize = isInitial ? 5 : 10;

      // Temperature: chaos gets higher randomness for wilder output.
      // Token cap keeps generation fast — 5 rules ≈ ~200 tokens, 10 ≈ ~400.
      const temperature = vibeKey === 'chaotic' ? 1.4 : vibeKey === 'drinking' ? 1.1 : 1.0;
      const maxOutputTokens = isInitial ? 400 : 600;

      // ── Attempt 1: main prompt ─────────────────────────────────────────────
      let newRules = [];
      let usedFallback = false;

      if (boxImg && !rulebookImg) {
        const prompt = `You are GLITCH — create ${batchSize} short funny temporary rule overlays for this board game.
📸 Identify the game from the box photo and write rules using its actual game terms.
VIBE: ${vibeKey === 'chaotic' ? 'CHAOS — invert or break normal rules' : vibeKey === 'drinking' ? 'drinking rules — specify who drinks and why' : 'family party — physical comedy, silly social challenges, safe for all ages'}
Format: [trigger] + [twist], max 10 words, no emojis.
Return ONLY: ["rule 1", "rule 2", ...]`;
        newRules = await runGenerationRequest(model, {
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: boxImg.split(',')[1] } }] }],
          generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens }
        }, 'box-image main');
      } else {
        const prompt = buildGlitchPrompt(knowledge, vibeKey, history, batchSize);
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens }
        };
        if (rulebookImg && isInitial) {
          body.contents[0].parts.push({ inlineData: { mimeType: 'image/jpeg', data: rulebookImg.split(',')[1] } });
        }
        newRules = await runGenerationRequest(model, body, 'knowledge main');
      }

      // ── Attempt 2: fallback prompt if main returned too few rules ──────────
      if (!isUsableRuleBatch(newRules, MIN_RULES)) {
        console.warn(`[GLITCH] main prompt returned ${newRules.length} rules (need ${MIN_RULES}) — trying fallback`);
        usedFallback = true;
        const fallbackPrompt = buildFallbackPrompt(knowledge, vibeKey, 5);
        newRules = await runGenerationRequest(model, {
          contents: [{ parts: [{ text: fallbackPrompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 1.0, maxOutputTokens: 400 }
        }, 'fallback');
        console.log(`[GLITCH] fallback returned ${newRules.length} rules`);
      } else {
        console.log(`[GLITCH] batch accepted: ${newRules.length} rules${usedFallback ? ' (fallback)' : ''}`);
      }

      // ── Accept or reject the batch ─────────────────────────────────────────
      if (isUsableRuleBatch(newRules, MIN_RULES)) {
        console.log(`[GLITCH] batch accepted: ${newRules.length} rules${usedFallback ? ' via fallback' : ''}`);
        setRulesQueue(prev => { const u = [...prev, ...newRules]; queueRef.current = u; return u; });
        if (isInitial) setScreen('game');
      } else {
        console.error(`[GLITCH] both attempts failed — ${newRules.length} rules after fallback`);
        throw new Error(`Generation failed: only ${newRules.length} usable rules after retry`);
      }

    } catch (error) {
      console.error('[GLITCH] generation error:', error.message);
      if (isInitial) {
        const fallback = [t.errors.networkError, t.errors.checkConnection, t.errors.tryAgain];
        setRulesQueue(fallback);
        queueRef.current = fallback;
        setScreen('game');
      }
      // Non-initial failures are silent — the queue stays as-is and the user can try again.
    } finally {
      isGeneratingRef.current = false;
      if (isInitial) setInitialLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_KEY, vibeKey, t]);

  // ─── HARD RESET ───────────────────────────────────────────────────────────
  const hardReset = useCallback(() => {
    setIsFlipped(false);
    setCurrentRule('');
    setRulesQueue([]);
    queueRef.current = [];
    setIsCoolingDown(false);
    setIsAutoMode(false);
    isGeneratingRef.current = false;
    historyRef.current = [];
    if (flipTimeoutRef.current) { clearTimeout(flipTimeoutRef.current); flipTimeoutRef.current = null; }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
  }, []);

  const exitGame = () => { hardReset(); setScreen('home'); };

  // ─── START GAME FLOW ──────────────────────────────────────────────────────
  // Flow: hardReset → loadGameKnowledge → confidence check → generateGlitchRulesBatch
  const startGame = async () => {
    hardReset();
    setInitialLoading(true);
    setShowWarning(null);

    const knowledge = await loadGameKnowledge();
    const hasImage = !!(boxImageRef.current || rulebookImageRef.current);
    const hasUsableKnowledge = knowledge.vocabulary.length > 0
      || knowledge.mechanics.length > 0
      || hasImage;

    // Library and rulebook paths always produce high confidence — proceed directly
    if (knowledge.confidence === 'high' || knowledge.confidence === 'medium') {
      await generateGlitchRulesBatch(true, knowledge);
      return;
    }

    // Box image bypasses knowledge check — vision identifies the game directly
    if (hasImage) {
      await generateGlitchRulesBatch(true, knowledge);
      return;
    }

    // Unknown game with no supporting knowledge — ask for rulebook upload
    if (!hasUsableKnowledge) {
      console.log('[GLITCH] startGame blocked: no usable knowledge, no image');
      setShowWarning('none');
      setInitialLoading(false);
      return;
    }

    // Low confidence fallback (BGG with few mechanics)
    console.log('[GLITCH] startGame: low confidence — showing warning but proceeding');
    setShowWarning('low');
    await generateGlitchRulesBatch(true, knowledge);
  };

  // ─── RULE QUEUE MANAGEMENT ────────────────────────────────────────────────
  const triggerGlitchEffect = () => {
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      }
    } catch {}
  };

  const pullNextRule = useCallback(() => {
    if (isCoolingDown) return;
    setIsCoolingDown(true);
    cooldownTimerRef.current = setTimeout(() => setIsCoolingDown(false), 5000);
    setIsFlipped(false);

    flipTimeoutRef.current = setTimeout(() => {
      let nextRule = '';
      if (queueRef.current.length > 0) {
        const q = [...queueRef.current];
        const item = q.shift();
        nextRule = typeof item === 'string' ? item.trim() : '';
        queueRef.current = q;
        setRulesQueue(q);
        setCurrentRule(nextRule);
        historyRef.current = [...historyRef.current, nextRule];
        if (q.length <= 3 && !isGeneratingRef.current) generateGlitchRulesBatch(false);
      } else {
        setCurrentRule(t.loadingMore);
        generateGlitchRulesBatch(false);
      }
      triggerGlitchEffect();
      setIsFlipped(true);
    }, 600);
  }, [isCoolingDown, generateGlitchRulesBatch, t.loadingMore]);

  useEffect(() => {
    const scheduleNext = () => {
      const delay = Math.floor(Math.random() * 45000) + 45000;
      timerRef.current = setTimeout(() => {
        if (isAutoMode && screen === 'game' && !isCoolingDown) pullNextRule();
        scheduleNext();
      }, delay);
    };
    if (screen === 'game' && isAutoMode) scheduleNext();
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [isAutoMode, screen, isCoolingDown, pullNextRule]);

  // ─── IMAGE HANDLERS ───────────────────────────────────────────────────────
  const handleBoxImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setBoxImageData(reader.result);
      boxImageRef.current = reader.result;
      setSearchTerm(''); searchTermRef.current = '';
      setSelectedGame(null); selectedGameRef.current = null;
      setBggMechanics(''); bggMechanicsRef.current = '';
      setGameKnowledge(emptyKnowledge()); gameKnowledgeRef.current = emptyKnowledge();
      setShowWarning(null);
    };
    reader.readAsDataURL(file);
  };

  const handleRulebookImage = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setRulebookImageData(reader.result);
      rulebookImageRef.current = reader.result;
      // Clear cached knowledge so the pipeline re-extracts from the new image
      setGameKnowledge(emptyKnowledge());
      gameKnowledgeRef.current = emptyKnowledge();
      setShowWarning(null);
    };
    reader.readAsDataURL(file);
  };

  const removeBoxImage = () => {
    setBoxImageData(null); boxImageRef.current = null;
    if (boxFileInputRef.current) boxFileInputRef.current.value = '';
  };

  const removeRulebookImage = () => {
    setRulebookImageData(null); rulebookImageRef.current = null;
    if (rulebookFileInputRef.current) rulebookFileInputRef.current.value = '';
  };

  // ─── COMPUTED ─────────────────────────────────────────────────────────────
  // Boot is allowed for: confirmed game (library or BGG) OR any uploaded image.
  // A library selection is the fastest path — no network, no uploads needed.
  const canStart = !initialLoading && !isLoadingKnowledge &&
    (!!selectedGame || !!boxImageData || !!rulebookImageData);

  const startLabel = isLoadingKnowledge ? t.loadingKnowledge
    : initialLoading ? t.loadingText
    : t.startGameBtn;

  // ─── RENDER HOME ──────────────────────────────────────────────────────────
  const renderHome = () => (
    <div className="card">
      <h1 className="glitch-title">{t.appName}</h1>

      <label style={{ marginTop: 20 }}>{t.chooseGameLabel}</label>

      <div ref={dropdownRef} style={{ position: 'relative', margin: '10px 0' }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder={t.gameInputPlaceholder}
            value={searchTerm}
            onChange={e => handleSearchChange(e.target.value)}
            onFocus={() => { if (searchTerm.length > 1 && !selectedGame) setShowDropdown(true); }}
            style={{
              width: '100%',
              padding: selectedGame ? '12px 36px 12px 12px' : '12px',
              backgroundColor: '#222',
              border: `1px solid ${selectedGame ? '#00ff88' : '#00d4ff'}`,
              color: '#fff', borderRadius: '8px', fontSize: '1rem',
              outline: 'none',
              boxShadow: selectedGame ? '0 0 10px #00ff88' : 'none',
              fontFamily: 'inherit'
            }}
          />
          {selectedGame && (
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '1.1rem', pointerEvents: 'none' }}>
              ✅
            </span>
          )}
        </div>

        {showDropdown && searchTerm.length > 1 && !selectedGame && (
          <ul style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            backgroundColor: '#111', border: '2px solid #ff0055',
            borderRadius: '0 0 8px 8px', zIndex: 9999, maxHeight: 250,
            overflowY: 'auto', listStyle: 'none', padding: 0, margin: 0
          }}>
            {/* Show "Searching..." only when there are no local results yet */}
            {fetchStatus === 'Loading' && searchResults.length === 0 && (
              <li style={{ padding: '15px 14px', color: '#aaa', fontSize: '1rem' }}>
                Searching games...
              </li>
            )}
            {searchResults.map(game => (
              <li
                key={`${game.source}_${game.id}`}
                onMouseDown={e => { e.preventDefault(); handleGameSelect(game); }}
                style={{
                  padding: '15px 14px', cursor: 'pointer', borderBottom: '1px solid #333',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  color: '#fff', fontSize: '1rem', backgroundColor: '#111'
                }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = '#1e1e1e'}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = '#111'}
              >
                <span>{game.name}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {/* Library badge — these games have full built-in knowledge */}
                  {game.source === 'library' && (
                    <span style={{
                      fontSize: '0.6rem', color: '#00ff88',
                      border: '1px solid #00ff88', borderRadius: 3,
                      padding: '1px 5px', letterSpacing: '0.05em'
                    }}>BUILT-IN</span>
                  )}
                  {game.year && <span style={{ color: '#888', fontSize: '0.8rem' }}>{game.year}</span>}
                </span>
              </li>
            ))}
            {/* No results after both library and BGG returned nothing */}
            {fetchStatus === 'Empty' && searchResults.length === 0 && (
              <li style={{ padding: '15px 14px', color: '#888', fontSize: '0.9rem' }}>
                No games found — try scanning a rulebook
              </li>
            )}
          </ul>
        )}
      </div>

      {/* BGG error is only shown when local library also returned nothing */}
      {!selectedGame && fetchStatus === 'Error' && searchResults.length === 0 && searchTerm.length > 1 && (
        <div style={{ fontSize: '0.8rem', color: '#ff0055', marginTop: 4, marginBottom: 6 }}>
          BGG lookup failed — check /api/bgg or network
        </div>
      )}

      {/* Selected game indicator */}
      {selectedGame && (
        <div style={{ fontSize: '0.8rem', color: '#00ff88', marginBottom: 6 }}>
          {selectedGame.source === 'library'
            ? '✓ Knowledge ready'
            : isFetchingMechanics ? '⏳ Loading metadata...'
            : bggMechanics ? `✓ ${bggMechanics}`
            : '✓ Game selected'}
        </div>
      )}

      {/* Confidence warnings */}
      {showWarning === 'low' && (
        <div style={{
          backgroundColor: 'rgba(255,165,0,0.1)', border: '1px solid #ffa500',
          borderRadius: '8px', padding: '12px', margin: '10px 0',
          color: '#ffa500', textAlign: 'center', fontSize: '0.9rem'
        }}>
          {t.lowConfidenceWarning}
        </div>
      )}
      {showWarning === 'none' && (
        <div style={{
          backgroundColor: 'rgba(255,0,85,0.1)', border: '1px solid #ff0055',
          borderRadius: '8px', padding: '12px', margin: '10px 0',
          color: '#ff0055', textAlign: 'center', fontSize: '0.9rem'
        }}>
          {t.noKnowledgeWarning}
        </div>
      )}

      {/* Image uploads */}
      <div style={{ display: 'flex', gap: '10px', marginTop: 15 }}>
        {/* Box image: visual identification only */}
        <div style={{ flex: 1 }}>
          {boxImageData ? (
            <div style={{ position: 'relative' }}>
              <img src={boxImageData} alt="box"
                style={{ width: '100%', height: 72, objectFit: 'cover', borderRadius: 8, border: '2px solid #00d4ff' }} />
              <button onClick={removeBoxImage} style={removeStyle}>×</button>
            </div>
          ) : (
            <button
              onClick={() => boxFileInputRef.current?.click()}
              style={uploadBtnStyle('#00d4ff')}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,212,255,0.1)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {t.scanBoxLabel}
            </button>
          )}
        </div>

        {/* Rulebook image: growth path for games not in the library */}
        <div style={{ flex: 1 }}>
          {rulebookImageData ? (
            <div style={{ position: 'relative' }}>
              <img src={rulebookImageData} alt="rulebook"
                style={{ width: '100%', height: 72, objectFit: 'cover', borderRadius: 8, border: '2px solid #ff9500' }} />
              <button onClick={removeRulebookImage} style={removeStyle}>×</button>
            </div>
          ) : (
            <button
              onClick={() => rulebookFileInputRef.current?.click()}
              style={uploadBtnStyle('#ff9500')}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,149,0,0.1)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {t.scanRulebookLabel}
            </button>
          )}
        </div>
      </div>

      <input type="file" ref={boxFileInputRef} style={{ display: 'none' }}
        accept="image/*" capture="environment" onChange={handleBoxImage} />
      <input type="file" ref={rulebookFileInputRef} style={{ display: 'none' }}
        accept="image/*" onChange={handleRulebookImage} />

      <label style={{ marginTop: 20 }}>{t.chooseVibeLabel}</label>
      <select value={vibeKey} onChange={e => setVibeKey(e.target.value)}>
        {Object.keys(t.vibes).map(k => (
          <option key={k} value={k}>{t.vibes[k]}</option>
        ))}
      </select>

      <button
        className="neon-btn"
        onClick={startGame}
        disabled={!canStart}
        style={{ opacity: canStart ? 1 : 0.5, marginTop: 20 }}
      >
        {startLabel}
      </button>
    </div>
  );

  // ─── RENDER GAME ──────────────────────────────────────────────────────────
  const renderGame = () => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <button onClick={exitGame}
          style={{ background: 'none', border: 'none', color: '#00d4ff', fontSize: '1.5rem', cursor: 'pointer', padding: 5 }}>
          🔙
        </button>
        <div style={{ color: '#aaa', fontSize: '0.9rem' }}>
          {gameKnowledge.gameName || selectedGame?.name || searchTerm
            || (boxImageData ? t.scannedGame : '')}
        </div>
      </div>

      <div className="flip-container">
        <div className={`flipper ${isFlipped ? 'flip-active' : ''}`}>
          <div className="front">{t.cardBackText}</div>
          <div className="back">{currentRule || t.rulePlaceholder}</div>
        </div>
      </div>

      {!isAutoMode && (
        <button
          className="big-pulse-button"
          onClick={pullNextRule}
          disabled={isCoolingDown}
          style={{
            borderColor: isCoolingDown ? '#ff0055' : '#00d4ff',
            color: isCoolingDown ? '#ff0055' : '#fff',
            boxShadow: isCoolingDown ? '0 0 15px #ff0055' : '0 0 20px #00d4ff',
            opacity: isCoolingDown ? 0.7 : 1,
            cursor: isCoolingDown ? 'not-allowed' : 'pointer'
          }}
        >
          {isCoolingDown ? t.recharging : 'GLITCH'}
        </button>
      )}

      <div style={{ height: 30 }} />

      <div className="auto-switch">
        <span style={{ color: isAutoMode ? '#00d4ff' : '#555', fontWeight: 'bold' }}>
          {isAutoMode ? t.autoModeActive : t.autoModeInactive}
        </span>
        <label className="switch">
          <input type="checkbox" checked={isAutoMode} onChange={e => setIsAutoMode(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      {isAutoMode && (
        <div style={{ color: '#555', fontSize: '0.8rem', marginTop: 10, textAlign: 'center' }}>
          {t.autoModeDesc}
        </div>
      )}
    </div>
  );

  return (
    <div className="app-container" dir={langConfig.dir} lang={langConfig.code}>
      {screen === 'home' ? renderHome() : renderGame()}
    </div>
  );
}

export default App;

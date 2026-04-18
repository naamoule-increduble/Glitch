import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

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
    noKnowledgeWarning: "Unknown game. Type the name or scan the rulebook to continue.",
    vibes: {
      chaotic: "Chaos 🔥",
      drinking: "Drinks 🍻",
      funny: "Silly 😂"
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
// Sources (in order of preference): localStorage cache → rulebook image → BGG minimal.

const normalizeGameKey = (gameName, gameId) => {
  if (gameId) return `bgg_${gameId}`;
  return `name_${(gameName || '').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
};

const getStoredGameKnowledge = (gameKey) => {
  try {
    const raw = localStorage.getItem(`glitch_gk_${gameKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const saveStoredGameKnowledge = (gameKey, knowledge) => {
  try { localStorage.setItem(`glitch_gk_${gameKey}`, JSON.stringify(knowledge)); }
  catch { /* localStorage unavailable — non-critical */ }
};

const emptyKnowledge = () => ({
  gameId: null,
  gameName: '',
  sourceType: 'manual',   // 'local' | 'rulebook_image' | 'bgg_minimal' | 'manual'
  confidence: 'low',       // 'high' | 'medium' | 'low'
  mechanics: [],           // BGG tag strings — metadata only, not rule text
  categories: [],
  vocabulary: [],          // game-specific nouns and terms
  actions: [],             // things players do
  coreElements: [],        // board spaces, card types, pieces, resources
  mutableHooks: [],        // specific moments safe to twist for one-round humor
  ruleSummary: '',
  rawRuleText: '',
});

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

  // ── BGG search state ──
  // BGG is used ONLY for game identification and light metadata (mechanic/category tags).
  // BGG tags are NOT canonical rule text and are never used as the sole source for generation.
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
  const isGeneratingRef = useRef(false); // guards concurrent generation calls
  const gameKnowledgeRef = useRef(emptyKnowledge());
  const selectedGameRef = useRef(null);
  const searchTermRef = useRef('');
  const bggMechanicsRef = useRef('');
  const boxImageRef = useRef(null);
  const rulebookImageRef = useRef(null);
  const historyRef = useRef([]); // tracks shown rules to avoid repeats

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
  // All BGG requests go through our Vercel serverless function (/api/bgg)
  // because BGG blocks direct browser requests (CORS) and public proxies.
  const proxyFetch = async (url) => {
    const res = await fetch(`/api/bgg?url=${encodeURIComponent(url)}`);
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
          year: yearEl?.getAttribute('value') || ''
        };
      }).filter(r => r.name !== 'Unknown');
    }
    // v1 API fallback (BGG sometimes routes through older endpoint)
    return Array.from(xml.querySelectorAll('boardgame')).slice(0, 8).map(item => {
      const nameEl = item.querySelector('name[primary="true"]') || item.querySelector('name');
      return {
        id: item.getAttribute('objectid'),
        name: nameEl?.textContent?.trim() || 'Unknown',
        year: item.querySelector('yearpublished')?.textContent?.trim() || ''
      };
    }).filter(r => r.name !== 'Unknown');
  };

  const searchBGG = useCallback(async (query) => {
    if (!query || query.trim().length < 2) {
      setSearchResults([]); setShowDropdown(false); setFetchStatus('Idle'); return;
    }
    setFetchStatus('Loading');
    setShowDropdown(true);
    try {
      const text = await proxyFetch(
        `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`
      );
      const results = parseBGGSearch(text);
      setSearchResults(results);
      setFetchStatus(results.length > 0 ? 'Ok' : 'Empty');
    } catch {
      setSearchResults([]);
      setFetchStatus('Error');
    }
  }, []);

  // Fetches BGG mechanic/category tags — light metadata only, not rule text.
  const fetchBGGMetadata = useCallback(async (gameId) => {
    if (!gameId) return;
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
      console.warn('BGG metadata unavailable (non-critical):', e.message);
    } finally {
      setIsFetchingMechanics(false);
    }
  }, []);

  const handleSearchChange = useCallback((value) => {
    setSearchTerm(value);
    searchTermRef.current = value;
    setSelectedGame(null);
    selectedGameRef.current = null;
    setBggMechanics('');
    bggMechanicsRef.current = '';
    setShowWarning(null);
    setGameKnowledge(emptyKnowledge());
    gameKnowledgeRef.current = emptyKnowledge();
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchBGG(value), 500);
  }, [searchBGG]);

  const handleGameSelect = useCallback((game) => {
    setSelectedGame(game);
    selectedGameRef.current = game;
    setSearchTerm(game.name);
    searchTermRef.current = game.name;
    setShowDropdown(false);
    setShowWarning(null);
    fetchBGGMetadata(game.id);
  }, [fetchBGGMetadata]);

  // ─── GEMINI MODEL SELECTION ───────────────────────────────────────────────
  const getBestModel = async () => {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
      const data = await res.json();
      return data.models?.find(m => m.name.includes('flash'))?.name
        || data.models?.find(m => m.name.includes('gemini-1.5-pro'))?.name
        || data.models?.[0]?.name
        || 'models/gemini-1.5-flash';
    } catch { return 'models/gemini-1.5-flash'; }
  };

  // ─── RULEBOOK KNOWLEDGE EXTRACTION ───────────────────────────────────────
  // Uses Gemini vision to read an actual rulebook image and extract structured knowledge.
  // This is the HIGH-QUALITY path — produces vocabulary, actions, mutableHooks, etc.
  // The result is stored in localStorage and reused on future sessions.
  // This is real game understanding, NOT a list of GLITCH rules.
  const extractKnowledgeFromRulebookImage = useCallback(async (imageData, gameName) => {
    const model = await getBestModel();
    const prompt = `You are a game analyst reading a photo of a board game rulebook or rules sheet.

Your job: extract structured knowledge about the REAL game rules visible in this image.
This is NOT for generating funny rules — it is for understanding how the actual game works.

Game name hint: "${gameName || 'unknown'}"

Return ONLY this JSON (no explanation, no markdown):
{
  "gameName": "exact game name from rulebook",
  "vocabulary": ["game-specific nouns visible in the text, e.g. 'sheriff', 'outlaw', 'property', 'district'"],
  "actions": ["things players can do, e.g. 'roll dice', 'draw card', 'place worker'"],
  "coreElements": ["board spaces, card types, pieces, resources, zones"],
  "mutableHooks": ["specific game moments that could be temporarily twisted for humor without breaking the game"],
  "ruleSummary": "1-2 sentence plain English summary of how the game works",
  "rawRuleText": "key rule phrases or sentences readable directly from the image",
  "confidence": "high"
}

Constraints:
- Use only what is actually visible in the image
- Be specific — use this game's own terminology
- mutableHooks must be concrete game moments, not generic actions
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
  }, [API_KEY]);

  // ─── GAME KNOWLEDGE PIPELINE ──────────────────────────────────────────────
  // Builds structured knowledge about the real game BEFORE any GLITCH rule generation.
  // Priority order: localStorage cache → rulebook image → BGG minimal → block.
  // Generated GLITCH rules are NEVER written here — only real game knowledge is stored.
  const loadGameKnowledge = useCallback(async () => {
    const game = selectedGameRef.current;
    const name = game?.name || searchTermRef.current?.trim() || '';
    const gameId = game?.id || null;
    const gameKey = normalizeGameKey(name, gameId);
    const rulebookImg = rulebookImageRef.current;
    const bggMechanicsStr = bggMechanicsRef.current;

    setIsLoadingKnowledge(true);
    setShowWarning(null);

    // A. Check localStorage for cached high/medium confidence knowledge
    const stored = getStoredGameKnowledge(gameKey);
    if (stored && (stored.confidence === 'high' || stored.confidence === 'medium')) {
      console.log('Game knowledge loaded from cache:', gameKey);
      setGameKnowledge(stored);
      gameKnowledgeRef.current = stored;
      setIsLoadingKnowledge(false);
      return stored;
    }

    // B. Rulebook image = highest quality source — Gemini reads actual rule text.
    //    Box image is deliberately excluded here: it shows components, not rule text.
    if (rulebookImg) {
      try {
        const extracted = await extractKnowledgeFromRulebookImage(rulebookImg, name);
        const knowledge = {
          ...emptyKnowledge(),
          gameId,
          gameName: extracted.gameName || name,
          sourceType: 'rulebook_image',
          confidence: extracted.confidence || 'high',
          vocabulary: extracted.vocabulary || [],
          actions: extracted.actions || [],
          coreElements: extracted.coreElements || [],
          mutableHooks: extracted.mutableHooks || [],
          ruleSummary: extracted.ruleSummary || '',
          rawRuleText: extracted.rawRuleText || '',
        };
        saveStoredGameKnowledge(gameKey, knowledge);
        setGameKnowledge(knowledge);
        gameKnowledgeRef.current = knowledge;
        setIsLoadingKnowledge(false);
        return knowledge;
      } catch (e) {
        console.warn('Rulebook extraction failed, falling through:', e.message);
      }
    }

    // C. BGG mechanics/categories = minimal knowledge, low-medium confidence.
    //    These are crowd-sourced tags — better than nothing but not rule text.
    if (bggMechanicsStr || name) {
      const mechanicsArr = bggMechanicsStr ? bggMechanicsStr.split(', ').filter(Boolean) : [];
      const confidence = mechanicsArr.length >= 3 ? 'medium' : 'low';
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

    // D. No knowledge at all — return empty and let caller decide
    const none = { ...emptyKnowledge(), gameName: name, gameId };
    setGameKnowledge(none);
    gameKnowledgeRef.current = none;
    setIsLoadingKnowledge(false);
    return none;
  }, [extractKnowledgeFromRulebookImage]);

  // ─── GLITCH RULE GENERATION ───────────────────────────────────────────────
  // Builds the generation prompt using real gameKnowledge fields.
  // GLITCH rules are temporary one-round overlays — never stored as canonical game knowledge.
  // The prompt uses game-specific vocabulary so rules sound like they belong to the game.
  const buildGlitchPrompt = (knowledge, vibeKey, history) => {
    const { gameName, vocabulary, actions, coreElements, mutableHooks, ruleSummary, mechanics, confidence } = knowledge;
    const hasRichKnowledge = vocabulary.length > 0 || coreElements.length > 0;

    const vibeInstructions = {
      chaotic: 'Total chaos — flip the game logic upside down.',
      drinking: 'Party rules — actions trigger drinking.',
      funny: 'Silly fun — harmless and family-friendly.',
    };

    const gameContext = hasRichKnowledge
      ? `Game: ${gameName}
Game vocabulary (use these terms): ${vocabulary.join(', ')}
Player actions: ${actions.join(', ')}
Core elements: ${coreElements.join(', ')}
Twistable moments (preferred targets): ${mutableHooks.join(', ')}
How the game works: ${ruleSummary}`
      : `Game: ${gameName}
Known mechanics: ${mechanics.join(', ')}
Context: ${ruleSummary}`;

    const historyBlock = history.length > 0
      ? `\n\n❌ Already shown — do not repeat:\n${history.slice(-20).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    const conservativeNote = confidence === 'medium'
      ? '\nNote: Knowledge is limited — ground rules in the game name and known mechanics.'
      : '';

    return `You are GLITCH — you create temporary one-round funny rule overlays for board games.
GLITCH rules are overlays only. They do not permanently change the game.

${gameContext}

🎯 Vibe: ${t.vibes[vibeKey]}
📋 Tone: ${vibeInstructions[vibeKey]}

⚡ WRITING RULES:
1. Max 6-10 words per rule
2. Use REAL game terms from this game — not generic words
3. Format: trigger + twist (e.g. "Roll doubles? Steal someone's card")
4. Twist the twistable moments — do not break core game identity
5. No emojis. No markdown. No explanations.
6. Return exactly 10 rules as a JSON array${conservativeNote}${historyBlock}

✅ Good (Monopoly): "Land on Go? Go to Jail instead"
✅ Good (Catan): "Place robber? Give a sheep to victim"
✅ Good (UNO): "Play a +4? Pick someone's card to discard"
❌ Bad: "Skip your turn!" (no trigger, too generic)

Return ONLY: ["rule 1", "rule 2", ...]`;
  };

  // generateGlitchRulesBatch: the GLITCH rule generator.
  // Renamed from fetchRulesBatch for clarity — this generates rules, it does not "fetch" them.
  // Input: real gameKnowledge (from loadGameKnowledge). Output: session-only rule strings.
  const generateGlitchRulesBatch = useCallback(async (isInitial = false, knowledgeOverride = null) => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    if (isInitial) setInitialLoading(true);

    const knowledge = knowledgeOverride || gameKnowledgeRef.current;
    const boxImg = boxImageRef.current;
    const rulebookImg = rulebookImageRef.current;
    const history = historyRef.current;

    try {
      const model = await getBestModel();
      let requestBody;

      if (boxImg && !rulebookImg) {
        // Box image only — use Gemini vision for weak visual identification.
        // No rulebook text means we can't do rich knowledge extraction here.
        const prompt = `You are GLITCH — create 10 short funny temporary rule overlays for this board game.
📸 Photo of a game box: identify the game and create rules using its actual elements.
🎯 Vibe: ${t.vibes[vibeKey]} — ${vibeKey === 'chaotic' ? 'chaos' : vibeKey === 'drinking' ? 'drinking rules' : 'silly fun'}
Rules: 6-10 words each, trigger + twist format, real game terms only, no emojis.
Return ONLY: ["rule 1", "rule 2", ...]`;
        requestBody = {
          contents: [{ parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: boxImg.split(',')[1] } }
          ]}],
          generationConfig: { responseMimeType: 'application/json' }
        };
      } else {
        // Knowledge-driven generation — uses real game structure, not model memory.
        const prompt = buildGlitchPrompt(knowledge, vibeKey, history);
        requestBody = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        };
        // Attach rulebook image on first batch for richer context
        if (rulebookImg && isInitial) {
          requestBody.contents[0].parts.push(
            { inlineData: { mimeType: 'image/jpeg', data: rulebookImg.split(',')[1] } }
          );
        }
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);

      let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      rawText = rawText.replace(/```json|```/g, '').trim();

      let parsed;
      try { parsed = JSON.parse(rawText); } catch { parsed = []; }

      const newRules = Array.isArray(parsed)
        ? parsed.map(item => (typeof item === 'string' ? item.trim() : item.rule || Object.values(item)[0] || ''))
                .filter(r => r.length > 3 && r.length < 200)
        : [];

      setRulesQueue(prev => { const u = [...prev, ...newRules]; queueRef.current = u; return u; });
      if (isInitial) setScreen('game');

    } catch (error) {
      console.error('GLITCH generation error:', error);
      if (isInitial) {
        const fallback = [t.errors.networkError, t.errors.checkConnection, t.errors.tryAgain];
        setRulesQueue(fallback);
        queueRef.current = fallback;
        setScreen('game');
      }
    } finally {
      isGeneratingRef.current = false;
      if (isInitial) setInitialLoading(false);
    }
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
  // New flow: hardReset → loadGameKnowledge → confidence check → generateGlitchRulesBatch
  // The app must understand the game before it can twist its rules.
  const startGame = async () => {
    hardReset();
    setInitialLoading(true);
    setShowWarning(null);

    const knowledge = await loadGameKnowledge();

    // Reject if we have absolutely no usable knowledge and no images
    const hasImage = !!(boxImageRef.current || rulebookImageRef.current);
    const hasSomething = knowledge.gameName || hasImage;
    const hasUsableKnowledge = hasImage || knowledge.mechanics.length > 0 || knowledge.vocabulary.length > 0;

    if (!hasSomething) {
      setShowWarning('none');
      setInitialLoading(false);
      return;
    }

    // Warn on low confidence but still allow generation if we have a name or image
    if (!hasUsableKnowledge && knowledge.confidence === 'low') {
      setShowWarning('low');
      setInitialLoading(false);
      return;
    }

    if (knowledge.confidence === 'low') setShowWarning('low');

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
      // Box image provides visual ID only — clear any typed search
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
      // Rulebook supplements the current game — don't clear the search term
      setGameKnowledge(emptyKnowledge()); // clear cached knowledge so pipeline re-extracts
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
  const canStart = !initialLoading && !isLoadingKnowledge &&
    (searchTerm.trim().length > 1 || !!boxImageData || !!rulebookImageData);

  const startLabel = isLoadingKnowledge ? t.loadingKnowledge
    : initialLoading ? t.loadingText
    : t.startGameBtn;

  // ─── RENDER HOME ──────────────────────────────────────────────────────────
  const renderHome = () => (
    <div className="card">
      <h1 className="glitch-title">{t.appName}</h1>

      <label style={{ marginTop: 20 }}>{t.chooseGameLabel}</label>

      {/* Game search — BGG used for identification only, not rule knowledge */}
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
            {fetchStatus === 'Loading' && (
              <li style={{ padding: '15px 14px', color: '#aaa', fontSize: '1rem' }}>
                Intercepting game database...
              </li>
            )}
            {searchResults.map(game => (
              <li
                key={game.id}
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
                {game.year && <span style={{ color: '#888', fontSize: '0.8rem' }}>{game.year}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* BGG metadata indicator — tags only, not rule knowledge */}
      {selectedGame && (
        <div style={{ fontSize: '0.8rem', color: '#00ff88', marginBottom: 6 }}>
          {isFetchingMechanics ? '⏳ Loading metadata...'
            : bggMechanics ? `✓ ${bggMechanics}`
            : '✓ Game selected'}
        </div>
      )}

      {/* Cached knowledge indicator */}
      {gameKnowledge.confidence === 'high' && gameKnowledge.sourceType === 'local' && (
        <div style={{ fontSize: '0.75rem', color: '#00ff88', marginBottom: 6 }}>
          ✓ Game knowledge cached
        </div>
      )}

      {/* Confidence warnings — guide user toward better knowledge sources */}
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

      {/* Image uploads — two distinct paths with different purposes */}
      <div style={{ display: 'flex', gap: '10px', marginTop: 15 }}>
        {/* Box image: weak visual identification — does not provide rule knowledge */}
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

        {/* Rulebook image: preferred source — Gemini extracts real game knowledge from rule text */}
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

      {/* Vibe */}
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

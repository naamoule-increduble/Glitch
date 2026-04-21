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

// Normalizes a name for fuzzy matching.
// Preserves both ASCII letters/digits AND Hebrew characters (U+0590–U+05FF).
// Strips everything else (spaces, punctuation, diacritics).
// This means "Taki" → "taki" and "טאקי" → "טאקי" — they still won't match each other
// by normalization alone. That's why aliases (stored at learn-time) are the real bridge.
const normalizeForMatch = (str) =>
  (str || '').toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]/g, '');

const getStoredGameKnowledge = (gameKey) => {
  try {
    const raw = localStorage.getItem(`glitch_gk_${gameKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

// Saves a learned local game entry and writes index keys for every known alias.
// Always stamps sourceType as 'learned_local' and updates timestamps.
// Multiple index keys are written so any alias (including the user's original
// search term) can resolve to the same entry on future sessions.
const saveStoredGameKnowledge = (gameKey, knowledge) => {
  try {
    const now = new Date().toISOString();
    const toStore = {
      ...knowledge,
      sourceType: 'learned_local',
      createdAt: knowledge.createdAt || now,
      updatedAt: now,
    };
    const data = JSON.stringify(toStore);
    localStorage.setItem(`glitch_gk_${gameKey}`, data);
    const allNames = [toStore.gameName, ...(toStore.aliases || [])].filter(Boolean);
    for (const n of allNames) {
      const norm = normalizeForMatch(n);
      if (norm.length < 2) continue;
      const nameKey = `glitch_gk_name_${norm}`;
      if (nameKey !== `glitch_gk_${gameKey}`) {
        localStorage.setItem(nameKey, data);
      }
    }
  } catch { /* localStorage unavailable — non-critical */ }
};

// Scans all stored game knowledge for a name match when the direct key lookup fails.
// Checks gameName AND aliases — because rulebook-learned games may be stored under
// the extracted name (e.g. Hebrew "טאקי") while the user types the English name "Taki".
// The original search term is preserved as an alias at learn-time to bridge this gap.
const findStoredKnowledgeByName = (searchName) => {
  try {
    const q = normalizeForMatch(searchName);
    if (q.length < 2) return null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('glitch_gk_')) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        if (!data) continue;
        // Check gameName and all aliases — matching should not depend on one canonical name.
        const allNames = [data.gameName, ...(data.aliases || [])].filter(Boolean);
        for (const n of allNames) {
          const stored = normalizeForMatch(n);
          if (stored.length < 2) continue;
          if (stored === q || stored.startsWith(q) || q.startsWith(stored)) return data;
        }
      } catch { continue; }
    }
    return null;
  } catch { return null; }
};

const emptyKnowledge = () => ({
  gameId: null,
  gameName: '',
  sourceType: 'manual',    // 'seed' | 'learned_local' | 'manual'
  confidence: 'low',
  sourceLanguage: '',
  aliases: [],
  mechanics: [],
  vocabulary: [],
  actions: [],
  coreElements: [],
  mutableHooks: [],
  earlyGameHooks: [],
  ruleSummary: '',
  rawRuleText: '',
  createdAt: null,
  updatedAt: null,
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
  // searchResults holds library matches. selectedGame carries source: 'library'.
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
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
  const dropdownRef = useRef(null);
  const queueRef = useRef([]);
  const isGeneratingRef = useRef(false);
  const gameKnowledgeRef = useRef(emptyKnowledge());
  const selectedGameRef = useRef(null);
  const searchTermRef = useRef('');
  const boxImageRef = useRef(null);
  const rulebookImageRef = useRef(null);
  const historyRef = useRef([]);

  // Keep refs in sync with state
  useEffect(() => { queueRef.current = rulesQueue; }, [rulesQueue]);
  useEffect(() => { gameKnowledgeRef.current = gameKnowledge; }, [gameKnowledge]);
  useEffect(() => { selectedGameRef.current = selectedGame; }, [selectedGame]);
  useEffect(() => { searchTermRef.current = searchTerm; }, [searchTerm]);
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

  const handleSearchChange = useCallback((value) => {
    console.log('[GLITCH] handleSearchChange:', value);
    setSearchTerm(value);
    searchTermRef.current = value;
    setSelectedGame(null);
    selectedGameRef.current = null;
    setShowWarning(null);
    setGameKnowledge(emptyKnowledge());
    gameKnowledgeRef.current = emptyKnowledge();

    if (!value || value.trim().length < 2) {
      setSearchResults([]);
      setShowDropdown(false);
      setFetchStatus('Idle');
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
    setFetchStatus(libraryMatches.length > 0 ? 'Ok' : 'Empty');
  }, []);

  const handleGameSelect = useCallback((game) => {
    console.log('[GLITCH] handleGameSelect:', game.name, '| source:', game.source, '| id:', game.id);
    setSelectedGame(game);
    selectedGameRef.current = game;
    setSearchTerm(game.name);
    searchTermRef.current = game.name;
    setShowDropdown(false);
    setShowWarning(null);
  }, []);

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
          generationConfig: {}
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
  //   A. Internal library      — instant, no network, curated seed knowledge
  //   B. Learned local library — user's previously extracted rulebook knowledge
  //   C. Fresh rulebook image  — Gemini vision extraction, saved as learned_local
  //   D. Nothing               — caller shows warning, asks for rulebook upload
  //
  // Generated GLITCH rules are NEVER written here.
  const loadGameKnowledge = useCallback(async () => {
    const game = selectedGameRef.current;
    const name = game?.name || searchTermRef.current?.trim() || '';
    const gameId = game?.id || null;
    const gameKey = normalizeGameKey(name, gameId);
    const rulebookImg = rulebookImageRef.current;

    setIsLoadingKnowledge(true);
    setShowWarning(null);

    // A. Internal library — always the first source. Instant, no network, curated.
    if (game?.source === 'library' && game.libraryEntry) {
      const entry = game.libraryEntry;
      console.log('[GLITCH] knowledge source: internal library (seed) —', entry.canonicalName);
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

    // B. Learned local library — previously extracted rulebook knowledge.
    //    First-class knowledge source, not temporary cache.
    //    Try direct key lookup, then alias scan for cross-language matches.
    const stored = getStoredGameKnowledge(gameKey) || findStoredKnowledgeByName(name);
    if (stored && (stored.confidence === 'high' || stored.confidence === 'medium')) {
      const aliasNote = (stored.aliases || []).length > 0 ? ` (aliases: ${stored.aliases.join(', ')})` : '';
      console.log('[GLITCH] knowledge source: learned local library —', stored.gameName, aliasNote);
      setGameKnowledge(stored);
      gameKnowledgeRef.current = stored;
      setIsLoadingKnowledge(false);
      return stored;
    }

    console.log('[GLITCH] knowledge source: no library/learned match | rulebookImg:', !!rulebookImg);

    // C. Fresh rulebook extraction — user uploaded a rulebook image.
    //    Gemini reads actual rule text. Saved as learned_local for future sessions.
    if (rulebookImg) {
      try {
        const extracted = await extractKnowledgeFromRulebookImage(rulebookImg, name);
        const now = new Date().toISOString();
        const knowledge = {
          ...emptyKnowledge(),
          gameId,
          gameName: extracted.gameName || name,
          sourceType: 'learned_local',
          confidence: extracted.confidence || 'high',
          sourceLanguage: extracted.sourceLanguage || '',
          vocabulary: extracted.vocabulary || [],
          actions: extracted.actions || [],
          coreElements: extracted.coreElements || [],
          mutableHooks: extracted.mutableHooks || [],
          earlyGameHooks: extracted.earlyGameHooks || [],
          ruleSummary: extracted.ruleSummary || '',
          rawRuleText: extracted.rawRuleText || '',
          aliases: name !== (extracted.gameName || name) ? [name] : [],
          createdAt: now,
          updatedAt: now,
        };
        saveStoredGameKnowledge(gameKey, knowledge);
        console.log('[GLITCH] knowledge source: fresh rulebook extraction → saved as learned_local —', knowledge.gameName);
        setGameKnowledge(knowledge);
        gameKnowledgeRef.current = knowledge;
        setIsLoadingKnowledge(false);
        return knowledge;
      } catch (e) {
        console.warn('[GLITCH] Rulebook extraction failed, falling through:', e.message);
      }
    }

    // D. No usable knowledge — caller shows the rulebook upload prompt.
    console.log('[GLITCH] knowledge source: none — no library, no learned entry, no image');
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

    // Output language always matches the app's UI language.
    // langConfig.name auto-adapts when more UI languages are added to LANGUAGES.
    const outputLang = langConfig.name;
    const hasNonEnglishContent = sourceLanguage && sourceLanguage.toLowerCase() !== outputLang.toLowerCase();

    return `You are GLITCH. You write temporary one-round rule overlays for board games.

⚠️ CRITICAL: Write ALL rules in ${outputLang}. Every word of every rule must be ${outputLang}.${hasNonEnglishContent ? ` The game data below contains ${sourceLanguage} text — use it only as reference, never copy it into your output.` : ''}

${gameContext}

VIBE: ${vibe.tone}
EXAMPLE STYLE: ${vibe.example}
AVOID: ${vibe.avoid}

RULES FOR WRITING RULES:
1. Format: [trigger] + [twist]. Max 10 words total.
2. Trigger must be a real game moment (from the trigger list above if provided)
3. Twist must be ${vibeKey === 'chaotic' ? 'surprising, disruptive, or an outright inversion' : vibeKey === 'drinking' ? 'tied to drinking — specify who and why' : 'silly, physical, or a fun social challenge'}
4. Translate any non-${outputLang} game terms into ${outputLang} in your output.
5. No emojis. No markdown. No explanations.
6. Return exactly ${batchSize} rules as a JSON array.${conservativeNote}${historyBlock}

REMINDER: Output must be ${outputLang} only.
Return ONLY: ["rule 1", "rule 2", ...]`;
  };

  // ─── GENERATION HELPERS ───────────────────────────────────────────────────

  // Parses raw model text into a clean string array.
  // Does NOT require JSON-mode output — works on plain text responses too.
  // Handles: bare arrays, object-wrapped arrays, preamble text, truncated arrays.
  const parseGeneratedRules = (rawText) => {
    const cleaned = (rawText || '').replace(/```json|```/g, '').trim();
    console.log('[GLITCH] parseGeneratedRules | raw length:', cleaned.length, '| preview:', cleaned.slice(0, 120));

    // ── Step 1: find the JSON array in the response ──────────────────────────
    // Plain text mode may include preamble like "Here are the rules:\n[...]"
    // We locate the first "[" and last "]" to extract just the array portion.
    let candidate = cleaned;
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      candidate = cleaned.slice(arrayStart, arrayEnd + 1);
    } else if (arrayStart !== -1) {
      // No closing ] — truncated. Grab from [ to end of text for repair below.
      candidate = cleaned.slice(arrayStart);
    }

    // ── Step 2: try strict parse of the extracted candidate ──────────────────
    let parsed;
    try {
      parsed = JSON.parse(candidate);
      console.log('[GLITCH] JSON parse: success | type:', Array.isArray(parsed) ? 'array' : typeof parsed);
    } catch (e) {
      console.warn('[GLITCH] JSON parse failed —', e.message, '— attempting repair');

      // ── Step 3: repair truncated array ───────────────────────────────────
      // Truncation produces: ["rule 1", "rule 2", "rule 3   ← no closing "  or ]
      // Find the last fully-closed string entry and close the array there.
      const lastClosedEntry = candidate.lastIndexOf('",');
      const lastClosedFinal = candidate.lastIndexOf('"]');
      const cutAt = Math.max(lastClosedEntry, lastClosedFinal);
      if (candidate.startsWith('[') && cutAt > 1) {
        const repaired = candidate.slice(0, lastClosedEntry + 1) + ']';
        try {
          parsed = JSON.parse(repaired);
          console.log('[GLITCH] JSON repair: recovered', Array.isArray(parsed) ? parsed.length : 0, 'entries from truncated output');
        } catch (e2) {
          console.warn('[GLITCH] JSON repair failed —', e2.message);
          return [];
        }
      } else {
        return [];
      }
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
    const raw = parsed
      .map(item => (typeof item === 'string' ? item.trim() : item?.rule || Object.values(item || {})[0] || ''))
      .filter(r => typeof r === 'string' && r.length > 3 && r.length < 200);
    const processed = processRawRules(raw);
    console.log('[GLITCH] cleaned rules:', processed.length, 'usable (from', raw.length, 'raw)');
    return processed;
  };

  // ── Rule quality pipeline ─────────────────────────────────────────────────

  // Light cleanup: strip markdown artifacts and normalize punctuation.
  // Does NOT rewrite meaning — only cleans surface formatting.
  const cleanRule = (rule) => {
    let r = rule;
    // Strip markdown bold/italic markers (**word** or *word*)
    r = r.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
    // Strip backticks
    r = r.replace(/`/g, '');
    // Normalize multiple spaces
    r = r.replace(/\s{2,}/g, ' ');
    // Normalize spacing around punctuation
    r = r.replace(/\s+([?.!,])/g, '$1');
    // Simple rewrite: "X means Y" → "X? Y." — catches the most common bad pattern
    r = r.replace(/^(.{3,40})\s+means\s+(.+)$/i, (_, trigger, twist) => {
      const t = trigger.trim().replace(/[.?!,]+$/, '');
      const tw = twist.trim().replace(/[.]+$/, '');
      return `${t}? ${tw.charAt(0).toUpperCase() + tw.slice(1)}.`;
    });
    return r.trim();
  };

  // Quality gate: returns false for rules with obvious bad patterns.
  // Keeps this lightweight — only rejects clearly broken output.
  const passesQualityFilter = (rule) => {
    if (!rule || rule.length < 5) return false;
    const r = rule.toLowerCase();
    // Still contains markdown markers after cleanup
    if (/\*/.test(rule) || /`/.test(rule)) return false;
    // Explanatory/meta constructions that don't sound like game events
    if (/ means /.test(r) && !/\?/.test(rule)) return false;
    if (/this rule/.test(r)) return false;
    if (/you now have to/.test(r)) return false;
    if (/players must now/.test(r)) return false;
    // Unfinished trailing junk (ends with connector words)
    if (/\b(and|or|but|if|when|then|the|a|an)\s*[.!?]?$/.test(r)) return false;
    return true;
  };

  // Applies cleanup then quality filter to a raw rule list.
  // Logs how many were dropped at each stage.
  const processRawRules = (rawRules) => {
    const cleaned = rawRules.map(cleanRule);
    const passed = cleaned.filter(passesQualityFilter);
    const dropped = rawRules.length - passed.length;
    if (dropped > 0) console.log(`[GLITCH] quality filter: dropped ${dropped}/${rawRules.length} rules`);
    return passed;
  };

  const isUsableRuleBatch = (rules, minCount = 2) => rules.length >= minCount;

  // Builds the minimal fallback prompt used when the main prompt fails.
  // Shorter than the main prompt but keeps GLITCH's event-card voice.
  // Style enforced: trigger + twist, "X? Y." format. No explanatory phrasing.
  const buildFallbackPrompt = (knowledge, vibeKey) => {
    const { gameName, vocabulary, mutableHooks } = knowledge;
    const vibeInstruction = vibeKey === 'chaotic'
      ? 'Chaos vibe: invert or break the normal rule. "Roll dice? Opponent moves instead."'
      : vibeKey === 'drinking'
      ? 'Drinking vibe: someone drinks. Say exactly who and why. "Draw a card? Take two sips."'
      : 'Family Party vibe: physical or silly challenge. "Play Reverse? Everyone claps twice."';
    const terms = (mutableHooks?.slice(0, 3).join(', ') || vocabulary?.slice(0, 5).join(', ') || gameName);
    const outputLang = langConfig.name;
    return `You are GLITCH. Write 5 temporary rule overlays for ${gameName}.
⚠️ Write every word in ${outputLang} only. If game terms are in another language, translate them.
${vibeInstruction}
Game moments to twist: ${terms}
Format: [trigger]? [twist]. Max 10 words. No emojis. No "X means Y". ${outputLang} only.
Return ONLY: ["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]`;
  };

  // Sends one generation request to Gemini and returns { rules, truncated }.
  // truncated=true means finishReason was MAX_TOKENS — caller can log/distinguish this.
  const runGenerationRequest = async (model, requestBody, label) => {
    console.log('[GLITCH] runGenerationRequest:', label);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
    );
    const data = await res.json();
    if (data.error) throw new Error('api:' + data.error.message);
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
    console.log('[GLITCH] finishReason:', finishReason, '| raw length:', rawText.length);
    const truncated = finishReason === 'MAX_TOKENS';
    if (truncated) console.warn('[GLITCH] ⚠️ MAX_TOKENS — response was cut off, attempting JSON repair');
    return { rules: parseGeneratedRules(rawText), truncated };
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
      const temperature = vibeKey === 'chaotic' ? 1.4 : vibeKey === 'drinking' ? 1.1 : 1.0;
      // No maxOutputTokens or responseMimeType — plain text mode lets the model use its
      // full default token budget. JSON mode was capping output to ~10-60 tokens in practice.

      console.log(`[GLITCH] batch config | isInitial:${isInitial} batchSize:${batchSize} temperature:${temperature} (plain text mode)`);

      // ── Attempt 1: main prompt ─────────────────────────────────────────────
      let newRules = [];
      let wasTruncated = false;
      let usedFallback = false;

      if (boxImg && !rulebookImg) {
        const prompt = `You are GLITCH — create ${batchSize} short funny temporary rule overlays for this board game.
📸 Identify the game from the box photo and write rules using its actual game terms.
VIBE: ${vibeKey === 'chaotic' ? 'CHAOS — invert or break normal rules' : vibeKey === 'drinking' ? 'drinking rules — specify who drinks and why' : 'family party — physical comedy, silly social challenges, safe for all ages'}
Format: [trigger] + [twist], max 10 words, no emojis.
Return ONLY a JSON array: ["rule 1", "rule 2", ...]`;
        ({ rules: newRules, truncated: wasTruncated } = await runGenerationRequest(model, {
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: boxImg.split(',')[1] } }] }],
          generationConfig: { temperature }
        }, 'box-image main'));
      } else {
        const prompt = buildGlitchPrompt(knowledge, vibeKey, history, batchSize);
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature }
        };
        // Only include the rulebook image if we don't already have structured knowledge
        // from a prior extraction. Library and learned_local entries already have all
        // necessary fields — re-sending the image wastes tokens without benefit.
        const hasStructuredKnowledge = knowledge.sourceType === 'seed' || knowledge.sourceType === 'learned_local';
        if (rulebookImg && isInitial && !hasStructuredKnowledge) {
          body.contents[0].parts.push({ inlineData: { mimeType: 'image/jpeg', data: rulebookImg.split(',')[1] } });
        }
        ({ rules: newRules, truncated: wasTruncated } = await runGenerationRequest(model, body, 'knowledge main'));
      }

      // ── Attempt 2: fallback prompt if main returned too few rules ──────────
      if (!isUsableRuleBatch(newRules, MIN_RULES)) {
        console.warn(`[GLITCH] main returned ${newRules.length} rules${wasTruncated ? ' (was truncated)' : ''} — trying fallback`);
        usedFallback = true;
        const fallbackPrompt = buildFallbackPrompt(knowledge, vibeKey);
        ({ rules: newRules } = await runGenerationRequest(model, {
          contents: [{ parts: [{ text: fallbackPrompt }] }],
          generationConfig: { temperature: 1.0 }
        }, 'fallback'));
        console.log(`[GLITCH] fallback returned ${newRules.length} rules`);
      }

      // ── Accept or reject the batch ─────────────────────────────────────────
      if (isUsableRuleBatch(newRules, MIN_RULES)) {
        console.log(`[GLITCH] ✅ batch accepted: ${newRules.length} rules${usedFallback ? ' via fallback' : ''}`);
        setRulesQueue(prev => { const u = [...prev, ...newRules]; queueRef.current = u; return u; });
        if (isInitial) setScreen('game');
      } else {
        console.error(`[GLITCH] ❌ both attempts failed — ${newRules.length} usable rules`);
        // Distinguish: truncation/parse failure vs actual network failure
        throw new Error(wasTruncated ? 'truncated' : 'parse:empty');
      }

    } catch (error) {
      console.error('[GLITCH] generation catch:', error.message);
      if (isInitial) {
        // "Network hiccup" only for real network/API errors.
        // Truncation and parse failures get a different message.
        const isTruncation = error.message === 'truncated' || error.message.startsWith('parse:');
        const fallback = isTruncation
          ? ['GLITCH signal lost — tap to retry', 'Output corrupted — try again', 'GLITCH mis-fired — one more time']
          : [t.errors.networkError, t.errors.checkConnection, t.errors.tryAgain];
        setRulesQueue(fallback);
        queueRef.current = fallback;
        setScreen('game');
      }
      // Non-initial failures are silent — queue stays, user can tap GLITCH again.
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

    // Low confidence — proceed with warning shown
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
  // Boot is allowed for: confirmed library game OR any uploaded image.
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
            {fetchStatus === 'Empty' && searchResults.length === 0 && (
              <li style={{ padding: '15px 14px', color: '#888', fontSize: '0.9rem' }}>
                No games found — try scanning a rulebook
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Selected game indicator */}
      {selectedGame && (
        <div style={{ fontSize: '0.8rem', color: '#00ff88', marginBottom: 6 }}>
          ✓ Knowledge ready
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

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
    chooseGameLabel: "TARGET ACQUISITION",
    chooseVibeLabel: "CALIBRATE THE DAMAGE",
    startGameBtn: "BOOT SYSTEM",
    rulePlaceholder: "> SYSTEM PRIMED. PRESS GLITCH.",
    cardBackText: "GLITCH",
    autoModeActive: "AUTO: ON",
    autoModeInactive: "AUTO: OFF",
    recharging: "Recharging...",
    scanBoxLabel: "[ OPTICAL OVERRIDE ] 📸",
    scanRulebookLabel: "[ UPLOAD RULEBOOK ] 📖",
    gameInputPlaceholder: "> Enter game name..._",
    loadingKnowledge: "Reading game...",
    loadingText: "Analyzing...",
    loadingMore: "Loading more...",
    scannedGame: "Scanned game",
    autoModeDesc: "System fires automatically every 45-90 seconds",
    lowConfidenceWarning: "Not enough game knowledge — upload the rulebook for sharper rules 📖",
    noKnowledgeWarning: "Game not in library — scan your rulebook so GLITCH can learn this game.",
    help: {
  title: "SYSTEM MANUAL",
  step1: "1. TARGET: Search for a game by name.",
  step2: "2. RULEBOOK: If the game is not found, upload a rulebook photo.",
  step3: "3. CALIBRATE: Choose your vibe and hit GLITCH.",
  close: "ACKNOWLEDGE"
    },
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
  globalGlitchHooks: [],   // round-level states overridable by INJECTED rules
  revivalHooks: [],         // player states that can be reversed (busted/frozen/stopped)
  overrideHooks: [],        // core mechanics that can be temporarily corrupted
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
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
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
  const [boxImageData] = useState(null);
  const [rulebookImageData, setRulebookImageData] = useState(null);

  // ── Session/game-loop state ──
  const [vibeKey, setVibeKey] = useState('chaotic');
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [rulesQueue, setRulesQueue] = useState([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [isFlipped, setIsFlipped] = useState(false);
  const [currentRule, setCurrentRule] = useState('');

  // ── Refs ──
  const timerRef = useRef(null);
  const flipTimeoutRef = useRef(null);
  const cooldownTimerRef = useRef(null);
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

  useEffect(() => {
    const hasSeenHelp = localStorage.getItem('glitch_has_seen_help');
    if (!hasSeenHelp) setShowHelp(true);
  }, []);

  const playCyberSound = (type) => {
    if (!sfxEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'hover' || type === 'click') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(1800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        osc.start(); osc.stop(ctx.currentTime + 0.05);
      } else if (type === 'glitch') {
        // Longer high-voltage electrical spark (0.6 seconds)
        osc.type = 'sawtooth';
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        let time = ctx.currentTime;
        for (let i = 0; i < 30; i++) {
          osc.frequency.setValueAtTime(1500 + Math.random() * 4000, time);
          time += 0.02;
        }
        osc.start(); osc.stop(ctx.currentTime + 0.6);
      }
    } catch (e) { console.log('Audio error', e); }
  };

  const handleCloseHelp = () => {
    localStorage.setItem('glitch_has_seen_help', 'true');
    playCyberSound('click');
    setShowHelp(false);
  };

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
        globalGlitchHooks: entry.globalGlitchHooks || [],
        revivalHooks: entry.revivalHooks || [],
        overrideHooks: entry.overrideHooks || [],
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
  // mutableHooks are provided as game context — hooks inform active rules, not just reactive triggers.
  // Language instruction ensures rules stay in the game's own language (e.g. Hebrew).
  const buildGlitchPrompt = (knowledge, vibeKey, history, batchSize = 10) => {
    const { gameName, vocabulary, actions, coreElements, mutableHooks, earlyGameHooks, ruleSummary, mechanics, confidence, globalGlitchHooks, revivalHooks, overrideHooks } = knowledge;
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

    // Strip stage-label prefixes from hooks before sending to the model.
    // This prevents the model from outputting "First X? ..." literally.
    // earlyGameHooks still influence WHICH hooks get priority — but the model
    // never sees "first", "initial", or "opening" as part of the trigger text.
    const sanitizeHook = (h) => h
      .replace(/^first time /i, '')
      .replace(/^first /i, '')
      .replace(/^initial /i, '')
      .replace(/^opening /i, '')
      .trim();

    // Vibes define behavioral defaults — what each mode does to the round.
    // tone, example, and avoid are all injected into the prompt.
    const VIBES = {
      chaotic: {
        tone: 'TOTAL CHAOS. Rewrite the current round. Default behaviors: corrupt card behavior, block safe endings, spread effects to everyone, reverse or distort action-card logic, force continuation, revive players or states, override normal rules. Rules must feel disruptive, unfair, or game-breaking — but still tied to real game mechanics.',
        example: '"This round, + cards hit everyone." | "Nobody ends on an action card." | "Color changes fail this round." | "Skip cards bounce back." | "Reverse changes nothing." | "Anyone eliminated is back in." | "Everyone plays open-hand." | "All blocked players draw one extra."',
        avoid: 'Reject any rule a player would accept calmly. Reject mild or balanced effects. Reject trigger-questions about rare or unseen events ("Played a King?", "Open TAKI?", "Passed Go?", "Super TAKI played?"). Reject rules that do not corrupt, override, revive, or distort something real. Chaos must feel sudden, unfair, and disruptive.',
      },
      drinking: {
        tone: 'PARTY DRINKING. Rewrite who drinks this round. Default: active drinking modifiers — round-wide effects, clearly naming who drinks and how drinking spreads. Punchy, social, immediate. Like a party card read aloud at a loud table.',
        example: '"+ cards make everyone sip." | "Skipped players drink one." | "Color changes pick a drinker." | "Anyone on last card drinks first." | "Blocked players toast and drink." | "This round, every action costs a sip."',
        avoid: 'NEVER: "the player must drink", "take a drink", "is required to drink". No dry or anonymous phrasing. No trigger-questions about rare or specific unseen events. Every rule must say WHO drinks clearly and with social sting.',
      },
      funny: {
        tone: 'FAMILY PARTY. Rewrite how people perform the game. Playful, theatrical, visible. Silly social rules are welcome — funny sounds, poses, dramatic voices, exaggerated reactions, clapping — but preferably tied to a real card type, game action, player state, or game moment. Not chaos — do not invert mechanics. Safe for all ages.',
        example: '"Color changes must be sung." | "Anyone who blocks strikes a pose." | "This round, all card plays need a sound effect." | "Last card? Eyebrow drama." | "Skipped players clap once." | "Everyone narrates their moves in sports-commentator voice."',
        avoid: 'No completely random unrelated silliness with no game connection. No rules that invert game mechanics — that is Chaos. No weak or flat instructions with no comic image. Every rule should feel at least lightly attached to the game.',
      },
    };

    const vibe = VIBES[vibeKey] || VIBES.funny;

    // mutableHooks provided as game context — the model uses them to anchor active rules
    // or (sparingly) as reactive triggers. Hooks are sanitized to remove stage-label prefixes
    // so the model never outputs "First X? ..." literally in a rule.
    const hookLabel = isEarlyGame && earlyGameHooks?.length > 0
      ? 'GAME MOMENTS (★ = priority)'
      : 'GAME MOMENTS';
    const earlySet = new Set(earlyGameHooks || []);
    const triggerBlock = activeHooks.length > 0
      ? `${hookLabel} — use as hooks for reactive rules OR as context for active round changes:\n${activeHooks.map(h => `  ${earlySet.has(h) ? '★' : '•'} ${sanitizeHook(h)}`).join('\n')}`
      : '';

    // Optional game-state context for INJECTED rules — only present when library defines them.
    const injectedParts = [];
    if ((globalGlitchHooks || []).length > 0)
      injectedParts.push(`ROUND STATES (can be overridden by INJECTED rules): ${globalGlitchHooks.join(' | ')}`);
    if ((revivalHooks || []).length > 0)
      injectedParts.push(`PLAYER STATES THAT CAN BE REVERSED: ${revivalHooks.join(' | ')}`);
    if ((overrideHooks || []).length > 0)
      injectedParts.push(`MECHANICS THAT CAN BE CORRUPTED: ${overrideHooks.join(' | ')}`);
    const injectedContextBlock = injectedParts.length > 0 ? '\n' + injectedParts.join('\n') : '';

    const gameContext = hasRichKnowledge
      ? `GAME: ${gameName}
HOW IT WORKS: ${ruleSummary}
GAME TERMS (use these — not generic board game words): ${vocabulary.join(', ')}
PLAYER ACTIONS: ${actions.slice(0, 8).join(' | ')}
CORE ELEMENTS: ${coreElements.join(', ')}
${triggerBlock}${injectedContextBlock}`
      : `GAME: ${gameName}
HOW IT WORKS: ${ruleSummary}
KNOWN MECHANICS: ${mechanics.join(', ')}${injectedContextBlock}`;

    const historyBlock = history.length > 0
      ? `\nALREADY USED — do not repeat:\n${history.slice(-15).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    const conservativeNote = confidence === 'medium'
      ? '\nNOTE: Limited knowledge — stay grounded in the game name and known mechanics only.'
      : '';

    // Output language always matches the app's UI language.
    // langConfig.name auto-adapts when more UI languages are added to LANGUAGES.
    const outputLang = langConfig.name;

    return `You are GLITCH. You write short game-changing rule cards for board games.

WRITE ALL RULES IN ${outputLang}.

CORE OUTPUT FORM:
Default output = ACTIVE ROUND RULES.
A GLITCH rule changes the game RIGHT NOW. Players apply it immediately, without needing the app to know what just happened at the table.

PREFER:
- "This round, ..."
- "Until next GLITCH, ..."
- "[card type] now ..."
- "[player state] players now ..."
- "Nobody may ..."
- "Everyone now ..."

REDUCE (only when trigger is extremely common and obvious to all players):
- "Played a [specific card]?" — app cannot see this
- "Drew a [card]?" — same problem
- Any trigger that requires knowing the exact live table event

RULE FAMILIES — every rule must fit exactly one:
1. ROUND MODIFIER — changes the current round globally
   e.g. "This round, + cards hit everyone." | "Color changes fail this round."
2. CARD-TYPE MODIFIER — changes how a real card or action type works right now
   e.g. "+ cards now skip instead." | "Skip cards bounce back."
3. PLAYER-STATUS MODIFIER — changes what happens to a player state right now
   e.g. "Skipped players draw one." | "Blocked players drink."
If a rule does not fit one of these three, do not output it.

QUALITY CHECK — every rule must pass all 5:
1. IMMEDIATE: players can apply it right now
2. GAME-ANCHORED: clearly tied to real mechanics, card types, or states of ${gameName}
3. CLEAR: understandable on first read
4. NATURAL: sounds like short human-written card text, not a translated system message
5. VIBE-CORRECT: fits the chosen mode

${gameContext}

PHASE:
${isEarlyGame
  ? 'Prefer rules that apply to the current table state. Avoid rules requiring built-up ownership, elimination history, or advanced board state.'
  : 'Use the full game state.'}

VIBE: ${vibe.tone}

EXAMPLES:
${vibe.example}

AVOID:
${vibe.avoid}

LANGUAGE:
Use plain spoken English. Prefer: "draw two", "drink now", "skip a turn", "everyone drinks", "play open-hand", "draw one".
Never use in card text: "declarations", "force drawing", "resolve", "corruption", "ownership", "modifier".

STYLE:
- Max 10 words per rule
- No "first", "initial", "opening" in output
- No explanations
- Return exactly ${batchSize} rules as a JSON array${conservativeNote}${historyBlock}

GOOD:
"This round, + cards hit everyone." | "Color changes fail this round." | "Skipped players draw one." | "Nobody ends on an action card." | "Color changes must be sung." | "Blocked players toast and drink."

BAD:
"Super TAKI played?" | "Open TAKI? ..." | "last card declarations now force drawing two" | "players draw pretending to fish" | "Ownership flips." | "The player must drink."

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
    // Strip stage-label prefixes that leak through from early-game hooks.
    // "First freeze?" → "Freeze?" | "First time passing Go?" → "Passing Go?"
    r = r.replace(/^(?:first time |first |initial |opening )([a-z])/i, (_, char) => char.toUpperCase());
    r = r.replace(/\bownership flips\b/gi, 'give them the deed');
    r = r.replace(/\bresolve it backwards\b/gi, 'do the opposite');
    r = r.replace(/\bthe player must drink\b/gi, 'drink');
    r = r.replace(/\bthe frozen player finishes their drink\b/gi, 'Frozen? Bottoms up.');
    r = r.replace(/\bstopped already\?/gi, 'Stopped?');
    r = r.replace(/\bis required to\b/gi, 'must');
    r = r.replace(/\bforces? (\w+) to\b/gi, 'makes $1');
    r = r.replace(/\bdeclarations\b/gi, 'calls');
    r = r.replace(/\bforce drawing\b/gi, 'draw');
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
    if (/ownership flips/.test(r)) return false;
    if (/resolve/.test(r)) return false;
    if (/redirected/.test(r)) return false;
    if (/state corruption/.test(r)) return false;
    if (/first time|^first |^initial |^opening /.test(r)) return false;
    if (/\bdeclarations\b/.test(r)) return false;
    if (/\bforce drawing\b/.test(r)) return false;
    if (/\bcorruption\b/.test(r)) return false;
    if (/\bmodifier\b/.test(r)) return false;
    if (/pretending to/.test(r)) return false;
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
  // Shorter than the main prompt — keeps active-rule default and vibe behavioral pattern.
  const buildFallbackPrompt = (knowledge, vibeKey) => {
  const { gameName, vocabulary, mutableHooks } = knowledge;
  const rawTerms = mutableHooks?.slice(0, 4) || vocabulary?.slice(0, 6) || [gameName];
  const terms = rawTerms
    .map(h => h.replace(/^first time /i,'').replace(/^first /i,'').replace(/^initial /i,'').replace(/^opening /i,'').trim())
    .join(', ');

  const vibeInstruction =
    vibeKey === 'chaotic'
      ? 'Chaos: rewrite the round — corrupt card behavior, block safe endings, spread effects, revive players. Disruptive, unfair, game-breaking. "This round..." or "Until next GLITCH..." shapes.'
      : vibeKey === 'drinking'
      ? 'Drinking: active drinking rules that start now — who drinks, how it spreads. Punchy, social, clear.'
      : 'Family Party: playful active rules — silly sounds, poses, funny voices, exaggerated reactions — lightly tied to real game actions or moments. Not chaos.';

  return `You are GLITCH.
Write 5 short rule cards for ${gameName}.
Write in English only.

Prefer: "This round, ...", "Until next GLITCH, ...", "[card type] now ...", "[player state] players now ..."
Avoid: trigger questions about specific unseen events ("Played a X?", "Drew a Y?")

Game terms and states to anchor rules to: ${terms}

${vibeInstruction}

Rules must be:
- active — players can apply immediately
- game-anchored — clearly tied to ${gameName}
- natural — short human-written card text, not a system message
- clear on first read
- max 10 words
- no "first", "initial", "opening", "declarations", "resolve", "modifier"
- no explanations

Return ONLY:
["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]`;
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
    if (hapticsEnabled && navigator.vibrate) navigator.vibrate([100, 50, 100]);
    playCyberSound('glitch');
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const removeRulebookImage = () => {
    setRulebookImageData(null);
    rulebookImageRef.current = null;
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
  const renderLoading = () => (
    <div className="card terminal-loading-screen">
      <div className="terminal-header">glitch_os_v3.1.4.exe</div>
      <div className="terminal-body">
        <p className="typing-text-1">&gt; INITIALIZING OVERRIDE...</p>
        <p className="typing-text-2">&gt; BYPASSING FIREWALLS...</p>
        <p className="typing-text-3">&gt; INJECTING [ {vibeKey.toUpperCase()} ] PROTOCOL...</p>
        <p className="blinking-cursor">&gt; _</p>
      </div>
      <div className="cyber-progress-bar">
        <div className="cyber-progress-fill"></div>
      </div>
    </div>
  );

  const renderHome = () => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginBottom: '10px' }}>
        <button className="cyber-btn-icon" onClick={() => { playCyberSound('click'); setShowSettings(true); }}>[ SYS_CFG ]</button>
        <button className="cyber-btn-icon" onClick={() => { playCyberSound('click'); setShowHelp(true); }}>[ ? ]</button>
      </div>
      <h1 className="glitch-title" data-text={t.appName}>{t.appName}</h1>

      <label style={{ marginTop: 20 }}>{t.chooseGameLabel}</label>

      <div ref={dropdownRef} style={{ position: 'relative', margin: '10px 0' }}>
        <div className="terminal-input-wrapper">
          <span className="terminal-search-icon">🔍</span>
          <input
            type="text"
            placeholder={t.gameInputPlaceholder}
            value={searchTerm}
            onChange={e => handleSearchChange(e.target.value)}
            onFocus={() => { if (searchTerm.length > 1 && !selectedGame) setShowDropdown(true); }}
          />
          {selectedGame && <span style={{ color: '#00ff88', fontSize: '0.9rem', flexShrink: 0 }}>▸</span>}
        </div>

        {showDropdown && searchTerm.length > 1 && !selectedGame && (
          <ul className="cyber-dropdown">
            {searchResults.map(game => (
              <li
                key={`${game.source}_${game.id}`}
                className="cyber-dropdown-item"
                onMouseDown={e => { e.preventDefault(); handleGameSelect(game); }}
              >
                <span>{game.name}</span>
                {game.source === 'library' && <span className="built-in-badge">BUILT-IN</span>}
              </li>
            ))}
            {fetchStatus === 'Empty' && searchResults.length === 0 && (
              <li className="cyber-dropdown-item" style={{ color: '#444', cursor: 'default' }}>
                No targets found — try a deep scan
              </li>
            )}
          </ul>
        )}
      </div>

      {selectedGame && (
        <div className="lock-indicator">▸ TARGET LOCKED: {selectedGame.name}</div>
      )}

      {showWarning === 'low' && (
        <div className="warning-box warning-low">{t.lowConfidenceWarning}</div>
      )}
      {showWarning === 'none' && (
        <div className="warning-box warning-none">{t.noKnowledgeWarning}</div>
      )}

      <div style={{ marginTop: 15 }}>
        {rulebookImageData ? (
          <div className="cyber-thumbnail">
            <img src={rulebookImageData} alt="rulebook" />
            <div className="scan-laser" />
            <button onClick={removeRulebookImage} style={removeStyle}>×</button>
          </div>
        ) : (
          <button onClick={() => rulebookFileInputRef.current?.click()} className="cyber-btn-secondary">
            {t.scanRulebookLabel}
          </button>
        )}
      </div>

      <input
        type="file"
        ref={rulebookFileInputRef}
        style={{ display: 'none' }}
        accept="image/*,.jpg,.jpeg,.png,.webp,.heic"
        onChange={handleRulebookImage}
      />

      <label style={{ marginTop: 20 }}>{t.chooseVibeLabel}</label>
      <select value={vibeKey} onChange={e => setVibeKey(e.target.value)}>
        {Object.keys(t.vibes).map(k => (
          <option key={k} value={k}>{t.vibes[k]}</option>
        ))}
      </select>

      <button
        className={`neon-btn${canStart ? ' pulse-active' : ''}`}
        onClick={startGame}
        disabled={!canStart}
        style={{ opacity: canStart ? 1 : 0.5, marginTop: 20 }}
      >
        {startLabel}
      </button>

      {showHelp && (
        <div className="cyber-modal-overlay">
          <div className="cyber-modal">
            <h2 className="modal-title">{t.help.title}</h2>
            <div className="modal-steps">
              <p>{t.help.step1}</p>
              <p>{t.help.step2}</p>
              <p>{t.help.step3}</p>
            </div>
            <button className="neon-btn-secondary" onClick={handleCloseHelp}>
              [ {t.help.close} ]
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="cyber-modal-overlay">
          <div className="cyber-modal settings-modal">
            <h2 className="modal-title">SYS_CFG</h2>

            <div className="settings-row">
              <span>AUDIO [SFX]</span>
              <label className="cyber-switch">
                <input type="checkbox" checked={sfxEnabled} onChange={e => { setSfxEnabled(e.target.checked); playCyberSound('click'); }} />
                <span className="slider"></span>
              </label>
            </div>

            <div className="settings-row">
              <span>HAPTICS</span>
              <label className="cyber-switch">
                <input type="checkbox" checked={hapticsEnabled} onChange={e => { setHapticsEnabled(e.target.checked); playCyberSound('click'); }} />
                <span className="slider"></span>
              </label>
            </div>

            <div className="credits-box">
              SYSTEM ARCHITECTS: <span className="highlight-name">INCREDIBLE US</span>
            </div>

            <button className="neon-btn-secondary" onClick={() => { playCyberSound('click'); setShowSettings(false); }}>
              [ SAVE &amp; EXIT ]
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // ─── RENDER GAME ──────────────────────────────────────────────────────────
  const renderGame = () => (
    <div className="card game-screen-layout">

      {/* Top Bar: Navigation & Status */}
      <div className="game-top-bar">
        <button className="cyber-btn-small error" onClick={exitGame}>
          [ REBOOT ]
        </button>
        <div className="target-name">TARGET: {gameKnowledge.gameName || selectedGame?.name || searchTerm || 'UNKNOWN'}</div>
        <div className="protocol-badge">
          PROTOCOL: {vibeKey.toUpperCase()}
        </div>
      </div>

      {/* Center: The Hologram */}
      <div className="hologram-display">
        <div className="hologram-text">{currentRule || t.rulePlaceholder}</div>
        <div className="stability-gauge"></div>
      </div>

      {/* Bottom: Main Controls */}
      <div className="game-bottom-controls">
        {!isAutoMode && (
          <button
            className={`glitch-btn-massive ${isCoolingDown ? 'cooling' : ''}`}
            onClick={pullNextRule}
            disabled={isCoolingDown}
          >
            {isCoolingDown ? '[ REBOOTING ]' : 'G L I T C H'}
          </button>
        )}

        {/* Auto Mode Switch */}
        <div className="auto-switch-container">
          <span className={isAutoMode ? 'auto-active-text' : ''}>
            {isAutoMode ? t.autoModeActive : t.autoModeInactive}
          </span>
          <label className="cyber-switch">
            <input type="checkbox" checked={isAutoMode} onChange={e => setIsAutoMode(e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>
      </div>

    </div>
  );

  return (
    <div className="app-container" dir={langConfig.dir} lang={langConfig.code}>
      <div className="scanlines"></div>
      {initialLoading ? renderLoading() : screen === 'home' ? renderHome() : renderGame()}
    </div>
  );
}

export default App;

import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

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
    scanBoxPlaceholder: "Snap the game box 📸",
    scanRulebookPlaceholder: "Snap your rulebook 📖",
    gameInputPlaceholder: "Search a board game...",
    unknownGameWarning: "Don't know this game! Snap a photo of the rules sheet and I'll read them directly 📖",
    loadingText: "Analyzing...",
    loadingMore: "Loading more...",
    scannedGame: "Scanned game",
    autoModeDesc: "System fires automatically every 45-90 seconds",
    searchingBgg: "Searching...",
    mechanicsLoaded: "Game mechanics loaded",
    vibes: {
      chaotic: "Chaos 🔥",
      drinking: "Drinks 🍻",
      funny: "Silly 😂"
    },
    errors: {
      corruptRule: "Corrupted rule",
      dataError: "Data error",
      networkError: "Network hiccup",
      checkConnection: "Check your internet",
      tryAgain: "Give it another shot"
    }
  }
};

function App() {
  const API_KEY = process.env.REACT_APP_GEMINI_KEY;
  const [lang] = useState('en');
  const langConfig = LANGUAGES[lang];
  const t = translations[lang];

  const [screen, setScreen] = useState('home');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null);
  const [gameMechanics, setGameMechanics] = useState('');
  const [isFetchingMechanics, setIsFetchingMechanics] = useState(false);
  const [vibeKey, setVibeKey] = useState('chaotic');
  const [imageData, setImageData] = useState(null);
  const [imageType, setImageType] = useState('box');
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [rulesQueue, setRulesQueue] = useState([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [currentRule, setCurrentRule] = useState('');
  const [showUnknownWarning, setShowUnknownWarning] = useState(false);
  const [fetchStatus, setFetchStatus] = useState('Idle');

  const timerRef = useRef(null);
  const fileInputRef = useRef(null);

  const searchDebounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const queueRef = useRef([]);
  const flipTimeoutRef = useRef(null);
  const cooldownTimerRef = useRef(null);
  const isFetchingRef = useRef(false);
  const gameMechanicsRef = useRef('');
  const selectedGameRef = useRef(null);
  const historyRef = useRef([]);

  useEffect(() => { queueRef.current = rulesQueue; }, [rulesQueue]);
  useEffect(() => { gameMechanicsRef.current = gameMechanics; }, [gameMechanics]);
  useEffect(() => { selectedGameRef.current = selectedGame; }, [selectedGame]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const parseBGGSearch = (text) => {
    if (!text || text.length < 30) return [];
    // BGG sometimes returns a retry message — surface it
    if (text.includes('<message>')) {
      console.warn('BGG returned a message instead of results:', text);
      return [];
    }
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    // Check for parse error
    if (xml.querySelector('parsererror')) {
      console.error('XML parse error. Raw text:', text.slice(0, 200));
      return [];
    }
    const items = Array.from(xml.querySelectorAll('item')).slice(0, 8);
    console.log('XML items found:', items.length, '| total attr:', xml.querySelector('items')?.getAttribute('total'));
    return items.map(item => {
      const nameEl = item.querySelector('name[type="primary"]') || item.querySelector('name');
      const yearEl = item.querySelector('yearpublished');
      return {
        id: item.getAttribute('id'),
        name: nameEl?.getAttribute('value') || 'Unknown',
        year: yearEl?.getAttribute('value') || ''
      };
    }).filter(r => r.name !== 'Unknown');
  };

  const proxyFetch = async (url) => {
    const res = await fetch(`/api/bgg?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error('bgg proxy status ' + res.status);
    const text = await res.text();
    console.log('BGG raw response (' + text.length + ' chars):', JSON.stringify(text.slice(0, 300)));
    return text;
  };

  const searchBGG = useCallback(async (query) => {
    if (!query || query.trim().length < 2) {
      setSearchResults([]);
      setShowDropdown(false);
      setFetchStatus('Idle');
      return;
    }
    setFetchStatus('Loading');
    setShowDropdown(true);
    const url = `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`;
    try {
      const text = await proxyFetch(url);
      const results = parseBGGSearch(text);
      console.log('Parsed results:', results);
      setSearchResults(results);
      if (results.length === 0) {
        setFetchStatus('Error: 0 results. Raw: ' + text.slice(0, 80));
      } else {
        setFetchStatus('Success: ' + results.length);
      }
    } catch (e) {
      console.error('Search failed:', e);
      setSearchResults([]);
      setFetchStatus('Error: ' + e.message);
    }
  }, []);

  const fetchGameMechanics = useCallback(async (gameId) => {
    if (!gameId) return;
    setIsFetchingMechanics(true);
    const url = `https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&stats=0`;
    try {
      const text = await proxyFetch(url);
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'text/xml');
      const mechanics = Array.from(xml.querySelectorAll('link[type="boardgamemechanic"]'))
        .map(el => el.getAttribute('value'))
        .filter(Boolean)
        .slice(0, 6);
      const categories = Array.from(xml.querySelectorAll('link[type="boardgamecategory"]'))
        .map(el => el.getAttribute('value'))
        .filter(Boolean)
        .slice(0, 3);
      const combined = [...mechanics, ...categories].join(', ');
      console.log('Mechanics:', combined);
      setGameMechanics(combined);
      gameMechanicsRef.current = combined;
    } catch (e) {
      console.error('Mechanics fetch failed:', e);
    } finally {
      setIsFetchingMechanics(false);
    }
  }, []);

  const handleSearchChange = useCallback((value) => {
    setSearchTerm(value);
    setSelectedGame(null);
    selectedGameRef.current = null;
    setGameMechanics('');
    gameMechanicsRef.current = '';
    setShowUnknownWarning(false);

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchBGG(value);
    }, 500);
  }, [searchBGG]);

  const handleGameSelect = useCallback((game) => {
    setSelectedGame(game);
    selectedGameRef.current = game;
    setSearchTerm(game.name);
    setShowDropdown(false);
    setShowUnknownWarning(false);
    fetchGameMechanics(game.id);
  }, [fetchGameMechanics]);

  const sanitizeRule = useCallback((item) => {
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'object' && item !== null) {
      const text = item.rule || item.text || item.description ||
                   item.rule_name || item.content || Object.values(item)[0];
      return typeof text === 'string' ? text.trim() : t.errors.corruptRule;
    }
    return t.errors.dataError;
  }, [t.errors.corruptRule, t.errors.dataError]);

  const hardReset = useCallback(() => {
    setIsFlipped(false);
    setCurrentRule('');
    setRulesQueue([]);
    queueRef.current = [];
    setIsCoolingDown(false);
    setIsAutoMode(false);
    isFetchingRef.current = false;
    historyRef.current = [];

    if (flipTimeoutRef.current) { clearTimeout(flipTimeoutRef.current); flipTimeoutRef.current = null; }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
  }, []);

  const exitGame = () => {
    hardReset();
    setScreen('home');
  };

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
    } catch (e) {}
  };

  const fetchRulesBatch = useCallback(async (isInitial = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (isInitial) setInitialLoading(true);

    try {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
      );
      const listData = await listRes.json();
      let bestModel = listData.models?.find(m => m.name.includes('flash'))?.name
        || listData.models?.find(m => m.name.includes('gemini-1.5-pro'))?.name
        || listData.models?.[0]?.name
        || 'models/gemini-1.5-flash';

      const game = selectedGameRef.current;
      const mechanics = gameMechanicsRef.current;
      const hasImage = !!imageData;
      const history = historyRef.current;

      const gameName = game ? game.name : 'unknown game';

      const vibePrompts = {
        chaotic: `Total chaos. Flip everything. Example: "Land on Go? Go to Jail instead"`,
        drinking: `Party drinking rules. Example: "Roll doubles? Everyone drinks"`,
        funny: `Silly family fun. Example: "Buy a property? Say it in a silly voice"`
      };

      const historyBlock = history.length > 0
        ? `\n\n❌ DO NOT repeat these rules (already shown):\n${history.slice(-20).map((r, i) => `${i + 1}. ${r}`).join('\n')}`
        : '';

      const mechanicsBlock = mechanics
        ? `\n🔧 Core mechanics/categories: ${mechanics}`
        : '';

      let prompt = `You are GLITCH - you create short, punchy, funny twisted rules for board games.

${hasImage ? (imageType === 'rulebook'
  ? `📖 This is a photo of a RULEBOOK / RULES SHEET. Read every rule and mechanic you can see in the text. Then create 10 GLITCH rules that are twisted, funny versions of the ACTUAL rules you read. Each GLITCH rule should directly reference a real rule or mechanic visible in the image.`
  : `📸 This is a photo of a game BOX or board. Identify the game name and its mechanics from what you see. Then create 10 GLITCH rules using specific elements you identify.`)
: `🎲 The game: ${gameName}${mechanicsBlock}

Do you know "${gameName}"? If yes - create rules. If no - return exactly: ["UNKNOWN_GAME"]`}

🎯 Vibe: ${t.vibes[vibeKey]}
📋 Tone: ${vibePrompts[vibeKey]}

⚡ RULES FOR WRITING:
1. SHORT! Max 6-10 words per rule
2. Each rule must mention a specific game element (card name, board space, piece, action from the game)
3. Simple structure: trigger + action. That's it
4. Fun and clear - a 10 year old should understand it instantly
5. No emojis
6. Return exactly 10 rules as JSON array${historyBlock}

IMPORTANT: Use REAL elements from ${hasImage ? 'the game in the image' : `"${gameName}"`} - cards, spaces, pieces, actions that actually exist in this game!
❌ No generic rules! No markdown! No explanations!
✅ Only: ["rule 1", "rule 2", ...]`;

      let requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      };

      if (hasImage) {
        requestBody.contents[0].parts.push({
          inlineData: { mimeType: 'image/jpeg', data: imageData.split(',')[1] }
        });
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${bestModel}:generateContent?key=${API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);

      let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

      let parsed;
      try { parsed = JSON.parse(rawText); } catch (e) { parsed = []; }

      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] === 'UNKNOWN_GAME') {
        setShowUnknownWarning(true);
        isFetchingRef.current = false;
        if (isInitial) setInitialLoading(false);
        return;
      }

      setShowUnknownWarning(false);
      let newRules = [];

      if (Array.isArray(parsed)) {
        newRules = parsed
          .map(item => sanitizeRule(item))
          .filter(rule => rule.length > 0 && rule.length < 200 && rule !== 'UNKNOWN_GAME');
      } else {
        newRules = rawText
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 5 && l.length < 200)
          .slice(0, 10);
      }

      setRulesQueue(prev => {
        const updated = [...prev, ...newRules];
        queueRef.current = updated;
        return updated;
      });

      if (isInitial) setScreen('game');

    } catch (error) {
      console.error('Fetch Error:', error);
      if (isInitial) {
        const fallback = [t.errors.networkError, t.errors.checkConnection, t.errors.tryAgain];
        setRulesQueue(fallback);
        queueRef.current = fallback;
        setScreen('game');
      }
    } finally {
      isFetchingRef.current = false;
      if (isInitial) setInitialLoading(false);
    }
  }, [API_KEY, imageData, imageType, t.vibes, t.errors, vibeKey, sanitizeRule]);

  const pullNextRule = useCallback(() => {
    if (isCoolingDown) return;

    setIsCoolingDown(true);
    cooldownTimerRef.current = setTimeout(() => setIsCoolingDown(false), 5000);
    setIsFlipped(false);

    flipTimeoutRef.current = setTimeout(() => {
      let nextRule = '';

      if (queueRef.current.length > 0) {
        const tempQueue = [...queueRef.current];
        const item = tempQueue.shift();
        nextRule = sanitizeRule(item);
        queueRef.current = tempQueue;
        setRulesQueue(tempQueue);
        setCurrentRule(nextRule);

        historyRef.current = [...historyRef.current, nextRule];

        if (tempQueue.length <= 3 && !isFetchingRef.current) {
          fetchRulesBatch(false);
        }
      } else {
        setCurrentRule(t.loadingMore);
        fetchRulesBatch(false);
      }

      triggerGlitchEffect();
      setIsFlipped(true);
    }, 600);
  }, [isCoolingDown, fetchRulesBatch, sanitizeRule, t.loadingMore]);

  useEffect(() => {
    const scheduleNext = () => {
      const delay = Math.floor(Math.random() * (90000 - 45000 + 1)) + 45000;
      timerRef.current = setTimeout(() => {
        if (isAutoMode && screen === 'game' && !isCoolingDown) pullNextRule();
        scheduleNext();
      }, delay);
    };

    if (screen === 'game' && isAutoMode) scheduleNext();
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [isAutoMode, screen, isCoolingDown, pullNextRule]);

  const handleImage = (e, type = 'box') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageData(reader.result);
        setImageType(type);
        setSelectedGame(null);
        selectedGameRef.current = null;
        setSearchTerm('');
        setGameMechanics('');
        gameMechanicsRef.current = '';
        setShowUnknownWarning(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setImageData(null);
    setImageType('box');
    setShowUnknownWarning(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const startGame = () => {
    hardReset();
    fetchRulesBatch(true);
  };

  const canStart = !initialLoading && (!!selectedGame || !!imageData);

  const renderHome = () => (
    <div className="card">
      <h1 className="glitch-title">{t.appName}</h1>

      <label style={{ marginTop: 20 }}>{t.chooseGameLabel}</label>

      {/* BGG Search — outer div is the positioning root for the dropdown */}
      <div ref={dropdownRef} style={{ position: 'relative', margin: '10px 0' }}>

        {/* Input row with lock indicator */}
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
              color: '#fff',
              borderRadius: '8px',
              fontSize: '1rem',
              outline: 'none',
              boxShadow: selectedGame ? '0 0 10px #00ff88' : 'none',
              fontFamily: 'inherit'
            }}
          />
          {selectedGame && (
            <span style={{
              position: 'absolute', right: 10, top: '50%',
              transform: 'translateY(-50%)', fontSize: '1.1rem', pointerEvents: 'none'
            }}>✅</span>
          )}
        </div>

        {/* Dropdown — top: 100% is relative to this outer div, not the debug panel */}
        {showDropdown && searchTerm.length > 1 && !selectedGame && (
          <ul style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            backgroundColor: '#111', border: '2px solid #ff0055',
            borderRadius: '0 0 8px 8px',
            zIndex: 9999, maxHeight: 250, overflowY: 'auto',
            listStyle: 'none', padding: 0, margin: 0
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
                  padding: '15px 14px', cursor: 'pointer',
                  borderBottom: '1px solid #333',
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
            {fetchStatus.startsWith('Error') && (
              <li style={{ padding: '15px 14px', color: '#ff4444', fontSize: '0.85rem' }}>
                {fetchStatus}
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Debug panel — only shown on error */}
      {fetchStatus.startsWith('Error') && (
        <div style={{ color: 'yellow', fontSize: '12px', padding: '2px 0 6px' }}>
          DEBUG: {fetchStatus}
        </div>
      )}

      {/* Mechanics indicator */}
      {selectedGame && (
        <div style={{ fontSize: '0.8rem', color: '#00ff88', marginBottom: 8 }}>
          {isFetchingMechanics
            ? '⏳ Loading mechanics...'
            : gameMechanics
              ? `✓ ${gameMechanics}`
              : '✓ Game locked in'}
        </div>
      )}

      {/* Unknown Game Warning */}
      {showUnknownWarning && !imageData && (
        <div style={{
          backgroundColor: 'rgba(255, 165, 0, 0.1)', border: '1px solid #ffa500',
          borderRadius: '8px', padding: '12px', margin: '10px 0',
          color: '#ffa500', textAlign: 'center', fontSize: '0.9rem'
        }}>
          {t.unknownGameWarning}
        </div>
      )}

      {/* Image Upload Section */}
      {imageData ? (
        <div style={{ position: 'relative', marginTop: 15, marginBottom: 15, display: 'flex', justifyContent: 'center' }}>
          <img
            src={imageData}
            style={{ width: '100%', maxHeight: '180px', objectFit: 'cover', borderRadius: 8, border: '2px solid #00d4ff' }}
            alt="game preview"
          />
          <button
            onClick={removeImage}
            style={{
              position: 'absolute', top: 5, right: 5,
              background: 'rgba(0,0,0,0.8)', color: 'white', border: 'none',
              borderRadius: '50%', width: 30, height: 30,
              cursor: 'pointer', fontSize: '1rem', fontWeight: 'bold', zIndex: 10
            }}
          >×</button>
        </div>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: '100%', marginTop: 15, padding: '14px', background: 'transparent',
            border: '1px dashed #00d4ff', borderRadius: '8px',
            color: '#00d4ff', fontSize: '0.95rem', cursor: 'pointer', transition: 'all 0.3s ease'
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0, 212, 255, 0.1)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          Scan Game 📸
        </button>
      )}

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/*"
        capture="environment"
        onChange={e => handleImage(e, 'box')}
      />

      {/* Vibe Selector */}
      <label style={{ marginTop: 20 }}>{t.chooseVibeLabel}</label>
      <select value={vibeKey} onChange={e => setVibeKey(e.target.value)}>
        {Object.keys(t.vibes).map(k => (
          <option key={k} value={k}>{t.vibes[k]}</option>
        ))}
      </select>

      {/* Start Button */}
      <button
        className="neon-btn"
        onClick={startGame}
        disabled={!canStart}
        style={{ opacity: canStart ? 1 : 0.5, marginTop: 20 }}
      >
        {initialLoading ? t.loadingText : t.startGameBtn}
      </button>
    </div>
  );

  const renderGame = () => (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <button
          onClick={exitGame}
          style={{ background: 'none', border: 'none', color: '#00d4ff', fontSize: '1.5rem', cursor: 'pointer', padding: 5 }}
        >
          🔙
        </button>
        <div style={{ color: '#aaa', fontSize: '0.9rem' }}>
          {imageData && !searchTerm
            ? t.scannedGame
            : (selectedGame?.name || searchTerm || '')}
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

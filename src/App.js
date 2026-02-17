import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

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
    scanPlaceholder: "Or snap a pic of the box/rules 📸",
    gameInputPlaceholder: "Type a game name...",
    quickGamesLabel: "Or pick a popular one:",
    unknownGameWarning: "🤔 Don't know that game. Try snapping a pic of the rules or the box for a better experience!",
    loadingText: "Analyzing...",
    loadingMore: "Loading more...",
    scannedGame: "Scanned game",
    autoModeDesc: "System fires automatically every 45-90 seconds",
    games: {
      monopoly: "Monopoly",
      taki: "Taki",
      catan: "Catan",
      poker: "Poker",
      rummikub: "Rummikub",
      uno: "UNO"
    },
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
  const API_KEY = "AIzaSyAowzTTPSmsxJEr1Xcpb3KXkPer4KxD2eE".trim();
  const t = translations.en;

  const [screen, setScreen] = useState('home');
  const [gameKey, setGameKey] = useState('');
  const [customGameName, setCustomGameName] = useState('');
  const [vibeKey, setVibeKey] = useState('chaotic');
  const [imageData, setImageData] = useState(null);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [rulesQueue, setRulesQueue] = useState([]);
  const [isFetchingBatch, setIsFetchingBatch] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [currentRule, setCurrentRule] = useState("");
  const [showUnknownWarning, setShowUnknownWarning] = useState(false);

  const timerRef = useRef(null);
  const fileInputRef = useRef(null);
  const queueRef = useRef([]);
  const flipTimeoutRef = useRef(null);
  const cooldownTimerRef = useRef(null);

  useEffect(() => {
    queueRef.current = rulesQueue;
  }, [rulesQueue]);

  const sanitizeRule = useCallback((item) => {
    if (typeof item === 'string') {
      return item.trim();
    }
    if (typeof item === 'object' && item !== null) {
      const text = item.rule || item.text || item.description ||
                   item.rule_name || item.content || Object.values(item)[0];
      return typeof text === 'string' ? text.trim() : t.errors.corruptRule;
    }
    return t.errors.dataError;
  }, [t.errors.corruptRule, t.errors.dataError]);

  const hardReset = useCallback(() => {
    setIsFlipped(false);
    setCurrentRule("");
    setRulesQueue([]);
    setIsCoolingDown(false);
    setIsAutoMode(false);

    if (flipTimeoutRef.current) {
      clearTimeout(flipTimeoutRef.current);
      flipTimeoutRef.current = null;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  const exitGame = () => {
    hardReset();
    setScreen('home');
  };

  const triggerGlitchEffect = () => {
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

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
    } catch (e) {
      console.log("Audio not supported", e);
    }
  };

  const fetchRulesBatch = useCallback(async (isInitial = false) => {
    if (isFetchingBatch) return;

    setIsFetchingBatch(true);
    if (isInitial) setInitialLoading(true);

    try {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
      );
      const listData = await listRes.json();

      let bestModel = listData.models?.find(m => m.name.includes("flash"))?.name;
      if (!bestModel) {
        bestModel = listData.models?.find(m => m.name.includes("gemini-1.5-pro"))?.name;
      }
      if (!bestModel && listData.models?.length > 0) {
        bestModel = listData.models[0].name;
      }
      if (!bestModel) {
        bestModel = "models/gemini-1.5-flash";
      }

      console.log("🤖 Using Model:", bestModel);

      const gameName = (customGameName && customGameName.trim() !== '')
        ? customGameName
        : (gameKey ? t.games[gameKey] : 'unknown game');

      const hasImage = !!imageData;

      const vibePrompts = {
        chaotic: `Wild, unhinged rules that flip the game upside down. Example: "Whoever's winning swaps places with whoever's losing - surprise, you're last now"`,
        drinking: `Drinking rules with clear triggers and a party vibe. Example: "Rolled an even number? Take a sip and make the player across from you drink too"`,
        funny: `Family-friendly silly rules with goofy challenges. Example: "Whoever's turn it is must speak in a British accent - break character and go back 3 spaces"`
      };

      let prompt = `
You are the GLITCH engine - a system that creates hilariously twisted rules for board games.

${hasImage ? `📸 Analyze this image:
1. Identify the game name
2. Read all visible rules and mechanics
3. Identify specific elements (cards, dice, tiles, categories, resources, etc.)
4. Create 10 GLITCH rules based directly on the mechanics you identified` : `🎲 The game: ${gameName}

🔍 First check:
- Do you know the game "${gameName}" and its mechanics?
- If yes - continue creating rules
- If not - return exactly: "UNKNOWN_GAME"`}

🎯 Vibe: ${t.vibes[vibeKey]}
📋 Style example: ${vibePrompts[vibeKey]}

⚡ MANDATORY writing rules:
1. Every rule MUST be specific to this game - use real elements from the game
2. Structure: clear condition → clear action → funny twist
3. Length: 8-20 words per rule (not too short!)
4. Write in a fun, casual tone - like a friend explaining house rules
5. Sound like something someone would actually say at game night, not a rulebook
6. No emojis in the rules themselves
7. Return exactly 10 rules
8. Format: JSON array of strings only

Good examples:
✅ "Rolled doubles? Nice, you get another turn - but you have to swap seats with the player on your left"
✅ "Landed on someone's property? Pay double rent AND give them a genuine compliment"
✅ "Chance or Community Chest cards must be read aloud in your best movie villain voice"
✅ "If you're in the lead, you have to play standing on one foot - fall over and it's back to Start"
✅ "Buying a property? You gotta sing about it or the deal's off"
✅ "The dice went missing, so next turn everyone just goes wherever they want"
✅ "Got three of a kind? Pass them to the player on your right... sorry about that"

Bad examples:
❌ "Double turn!" - unclear what triggers it
❌ "Swap!" - swap what with whom?
❌ "Player skips" - why and when?

Game-specific elements:
- Monopoly: spaces, streets, money, properties, hotels, bank, jail
- Card games (Taki/UNO): cards, colors, +2/+4, reverse, hands, draw pile
- Catan: resources, settlements, roads, development cards, robber
- Dice games: rolls, specific numbers, doubles, snake eyes
- Rummikub: tiles, runs, groups, jokers

❌ Do NOT create generic rules that could work for any game!
❌ Do NOT add markdown or explanations!
✅ Only JSON: ["rule 1", "rule 2", ...]

${hasImage ? '📸 Base your rules only on what you see in the image. Create rules that match the specific mechanics of this game.' : `🎮 Identify "${gameName}", understand its unique mechanics, and create rules that twist the original rules in creative ways.`}
`;

      let requestBody = {
        contents: [{
          parts: [{ text: prompt }]
        }]
      };

      if (hasImage) {
        requestBody.contents[0].parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: imageData.split(',')[1]
          }
        });
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${bestModel}:generateContent?key=${API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        }
      );

      const data = await res.json();

      if (data.error) {
        throw new Error(data.error.message);
      }

      let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

      rawText = rawText
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

      // Check if game is unknown
      if (rawText.includes("UNKNOWN_GAME")) {
        console.log("⚠️ Unknown game detected");
        setShowUnknownWarning(true);
        setIsFetchingBatch(false);
        if (isInitial) setInitialLoading(false);
        return;
      }

      setShowUnknownWarning(false);
      let newRulesArray = [];

      try {
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) {
          newRulesArray = parsed
            .map(item => sanitizeRule(item))
            .filter(rule => rule.length > 0 && rule.length < 200);
        }
      } catch (e) {
        console.warn("⚠️ JSON parsing failed, using fallback", e);
        newRulesArray = rawText
          .split("\n")
          .map(line => line.trim())
          .filter(line => line.length > 5 && line.length < 200)
          .slice(0, 10);
      }

      console.log(`✅ Fetched ${newRulesArray.length} rules`);

      setRulesQueue(prevQueue => [...prevQueue, ...newRulesArray]);

      if (isInitial) {
        setScreen('game');
      }

    } catch (error) {
      console.error("❌ Fetch Error:", error);

      if (isInitial) {
        setRulesQueue([
          t.errors.networkError,
          t.errors.checkConnection,
          t.errors.tryAgain
        ]);
        setScreen('game');
      }
    } finally {
      setIsFetchingBatch(false);
      if (isInitial) setInitialLoading(false);
    }
  }, [API_KEY, customGameName, gameKey, imageData, isFetchingBatch, t.games, t.vibes, t.errors, vibeKey, sanitizeRule]);

  const pullNextRule = useCallback(() => {
    if (isCoolingDown) return;

    setIsCoolingDown(true);
    cooldownTimerRef.current = setTimeout(() => {
      setIsCoolingDown(false);
    }, 5000);

    setIsFlipped(false);

    flipTimeoutRef.current = setTimeout(() => {
      let nextRule = "";

      if (queueRef.current.length > 0) {
        const tempQueue = [...queueRef.current];
        const item = tempQueue.shift();

        nextRule = sanitizeRule(item);
        setRulesQueue(tempQueue);
        setCurrentRule(nextRule);

        if (tempQueue.length < 3 && !isFetchingBatch) {
          console.log("🔄 Refilling queue...");
          fetchRulesBatch(false);
        }
      } else {
        setCurrentRule(t.loadingMore);
        fetchRulesBatch(false);
      }

      triggerGlitchEffect();
      setIsFlipped(true);
    }, 600);
  }, [isCoolingDown, isFetchingBatch, fetchRulesBatch, sanitizeRule, t.loadingMore]);

  useEffect(() => {
    const scheduleNext = () => {
      const delay = Math.floor(Math.random() * (90000 - 45000 + 1)) + 45000;

      timerRef.current = setTimeout(() => {
        if (isAutoMode && screen === 'game' && !isCoolingDown) {
          pullNextRule();
        }
        scheduleNext();
      }, delay);
    };

    if (screen === 'game' && isAutoMode) {
      scheduleNext();
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAutoMode, screen, isCoolingDown, pullNextRule]);

  const handleImage = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageData(reader.result);
        setGameKey('');
        setCustomGameName('');
        setShowUnknownWarning(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setImageData(null);
    setGameKey('');
    setCustomGameName('');
    setShowUnknownWarning(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const startGame = () => {
    hardReset();
    fetchRulesBatch(true);
  };

  const renderHome = () => (
    <div className="card" style={{maxHeight: '90vh', overflowY: 'auto'}}>
      <h1 className="glitch-title">{t.appName}</h1>

      <label style={{marginTop: 20}}>{t.chooseGameLabel}</label>

      {/* Text Input for Game Name */}
      <input
        type="text"
        placeholder={t.gameInputPlaceholder}
        value={customGameName}
        onChange={e => {
          setCustomGameName(e.target.value);
          setShowUnknownWarning(false);
        }}
        className="neon-input"
        style={{
          width: '100%',
          padding: '12px',
          margin: '10px 0',
          backgroundColor: '#222',
          border: '1px solid #00d4ff',
          color: '#fff',
          borderRadius: '8px',
          textAlign: 'left',
          fontSize: '1rem',
          outline: 'none',
          boxShadow: customGameName ? '0 0 10px #00d4ff' : 'none',
          transition: 'all 0.3s ease'
        }}
      />

      {/* Unknown Game Warning */}
      {showUnknownWarning && !imageData && (
        <div style={{
          backgroundColor: 'rgba(255, 165, 0, 0.1)',
          border: '1px solid #ffa500',
          borderRadius: '8px',
          padding: '12px',
          margin: '10px 0',
          color: '#ffa500',
          textAlign: 'center',
          fontSize: '0.9rem'
        }}>
          {t.unknownGameWarning}
        </div>
      )}

      {/* Quick Game Buttons */}
      {!imageData && (
        <>
          <label style={{fontSize: '0.85rem', marginTop: 15}}>{t.quickGamesLabel}</label>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '10px',
            marginTop: 10
          }}>
            {Object.keys(t.games).map(key => (
              <button
                key={key}
                onClick={() => {
                  setCustomGameName(t.games[key]);
                  setGameKey(key);
                  setShowUnknownWarning(false);
                }}
                style={{
                  padding: '10px',
                  background: customGameName === t.games[key] ? 'rgba(0, 212, 255, 0.2)' : 'transparent',
                  border: '1px solid #00d4ff',
                  borderRadius: '8px',
                  color: '#00d4ff',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease'
                }}
                onMouseEnter={e => {
                  if (customGameName !== t.games[key]) {
                    e.target.style.background = 'rgba(0, 212, 255, 0.1)';
                  }
                }}
                onMouseLeave={e => {
                  if (customGameName !== t.games[key]) {
                    e.target.style.background = 'transparent';
                  }
                }}
              >
                {t.games[key]}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Image Upload Section */}
      {imageData ? (
        <div style={{
          position: 'relative',
          marginTop: 15,
          marginBottom: 15,
          display: 'flex',
          justifyContent: 'center'
        }}>
          <img
            src={imageData}
            style={{
              width: '100%',
              maxHeight: '180px',
              objectFit: 'cover',
              borderRadius: 8,
              border: '2px solid #00d4ff'
            }}
            alt="game preview"
          />
          <button
            onClick={removeImage}
            style={{
              position: 'absolute',
              top: 5,
              right: 5,
              background: 'rgba(0,0,0,0.8)',
              color: 'white',
              border: 'none',
              borderRadius: '50%',
              width: 30,
              height: 30,
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              zIndex: 10
            }}
          >×</button>
        </div>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            width: '100%',
            padding: '12px',
            marginTop: 15,
            background: 'transparent',
            border: '1px dashed #00d4ff',
            borderRadius: '8px',
            color: '#00d4ff',
            fontSize: '0.9rem',
            cursor: 'pointer',
            transition: 'all 0.3s ease'
          }}
          onMouseEnter={e => e.target.style.background = 'rgba(0, 212, 255, 0.1)'}
          onMouseLeave={e => e.target.style.background = 'transparent'}
        >
          {t.scanPlaceholder}
        </button>
      )}

      <input
        type="file"
        ref={fileInputRef}
        style={{display: 'none'}}
        accept="image/*"
        onChange={handleImage}
      />

      {/* Vibe Selector */}
      <label style={{marginTop: 20}}>{t.chooseVibeLabel}</label>
      <select
        value={vibeKey}
        onChange={e => setVibeKey(e.target.value)}
      >
        {Object.keys(t.vibes).map(k => (
          <option key={k} value={k}>{t.vibes[k]}</option>
        ))}
      </select>

      {/* Start Button */}
      <button
        className="neon-btn"
        onClick={startGame}
        disabled={initialLoading || (!customGameName.trim() && !imageData)}
        style={{
          opacity: (initialLoading || (!customGameName.trim() && !imageData)) ? 0.5 : 1,
          marginTop: 20
        }}
      >
        {initialLoading ? t.loadingText : t.startGameBtn}
      </button>
    </div>
  );

  const renderGame = () => (
    <div className="card">
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20
      }}>
        <button
          onClick={exitGame}
          style={{
            background: 'none',
            border: 'none',
            color: '#00d4ff',
            fontSize: '1.5rem',
            cursor: 'pointer',
            padding: 5
          }}
        >
          🔙
        </button>

        <div style={{color: '#aaa', fontSize: '0.9rem'}}>
          {imageData && !customGameName
            ? t.scannedGame
            : (customGameName || t.games[gameKey] || '')
          }
        </div>
      </div>

      <div className="flip-container">
        <div className={`flipper ${isFlipped ? 'flip-active' : ''}`}>
          <div className="front">
            {t.cardBackText}
          </div>
          <div className="back">
            {currentRule || t.rulePlaceholder}
          </div>
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
            boxShadow: isCoolingDown
              ? '0 0 15px #ff0055'
              : '0 0 20px #00d4ff',
            opacity: isCoolingDown ? 0.7 : 1,
            cursor: isCoolingDown ? 'not-allowed' : 'pointer'
          }}
        >
          {isCoolingDown ? t.recharging : "GLITCH"}
        </button>
      )}

      <div style={{height: 30}}></div>

      <div className="auto-switch">
        <span style={{
          color: isAutoMode ? '#00d4ff' : '#555',
          fontWeight: 'bold'
        }}>
          {isAutoMode ? t.autoModeActive : t.autoModeInactive}
        </span>

        <label className="switch">
          <input
            type="checkbox"
            checked={isAutoMode}
            onChange={e => setIsAutoMode(e.target.checked)}
          />
          <span className="slider"></span>
        </label>
      </div>

      {isAutoMode && (
        <div style={{
          color: '#555',
          fontSize: '0.8rem',
          marginTop: 10,
          textAlign: 'center'
        }}>
          {t.autoModeDesc}
        </div>
      )}

      <div style={{
        position: 'absolute',
        bottom: 5,
        left: 10,
        fontSize: 10,
        color: '#333'
      }}>
        Queue: {rulesQueue.length} | Fetching: {isFetchingBatch ? 'Y' : 'N'}
      </div>
    </div>
  );

  return (
    <div className="app-container">
      {screen === 'home' ? renderHome() : renderGame()}
    </div>
  );
}

export default App;

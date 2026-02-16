import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const translations = {
  he: {
    appName: "GLITCH",
    chooseGameLabel: "פרוטוקול משחק:",
    chooseVibeLabel: "רמת עצימות:",
    startGameBtn: "אתחל מערכת",
    rulePlaceholder: "ממתין לפקודה...",
    cardBackText: "GLITCH",
    autoModeActive: "AUTO: ON",
    autoModeInactive: "AUTO: OFF",
    recharging: "טוען אנרגיה...",
    scanPlaceholder: "סרוק קופסה / לוח 📸",
    gameInputPlaceholder: "או הקלד שם משחק...",
    games: {
      monopoly: "מונופול",
      taki: "טאקי", 
      catan: "קטאן",
      poker: "פוקר",
      rummikub: "רמיקוב",
      uno: "אונו",
      camera: "--- סרוק משחק 📸 ---"
    },
    vibes: {
      chaotic: "כאוס",
      drinking: "שתייה (18+)",
      funny: "שטותי"
    }
  }
};

function App() {
  const API_KEY = "AIzaSyAowzTTPSmsxJEr1Xcpb3KXkPer4KxD2eE".trim(); 
  const t = translations.he;

  const [screen, setScreen] = useState('home');
  const [gameKey, setGameKey] = useState('monopoly');
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

  const timerRef = useRef(null);
  const fileInputRef = useRef(null);
  const queueRef = useRef([]); 
  const flipTimeoutRef = useRef(null); 
  const cooldownTimerRef = useRef(null);

  useEffect(() => {
    queueRef.current = rulesQueue;
  }, [rulesQueue]);

  const sanitizeRule = (item) => {
    if (typeof item === 'string') {
      return item.trim();
    }
    if (typeof item === 'object' && item !== null) {
      const text = item.rule || item.text || item.description || 
                   item.rule_name || item.content || Object.values(item)[0];
      return typeof text === 'string' ? text.trim() : "חוק משובש";
    }
    return "שגיאת נתונים";
  };

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
        : t.games[gameKey];
      
      const hasImage = (gameKey === 'camera' && imageData);

      const vibePrompts = {
        chaotic: `חוקים מטורפים שיהפכו את המשחק לכאוס מוחלט. שנה כללי ניצחון, הוסף תנאים אבסורדיים, צור מצבים מגוחכים.`,
        drinking: `חוקים של שתייה למבוגרים (18+). קבע מתי לשתות, כמה, ובאילו תנאים. היה יצירתי אבל אחראי.`,
        funny: `חוקים מצחיקים ומשפחתיים. גרסת "כאוס לייט" - שטויות מצחיקות בלי אלכוהול או תוכן למבוגרים.`
      };

      let prompt = `
אתה מנוע GLITCH - מערכת שיוצרת חוקים משוגעים למשחקי קופסה.

${hasImage ? '📸 זוהה תמונה של משחק.' : `🎲 המשחק: ${gameName}`}

🎯 קטגוריה: ${t.vibes[vibeKey]}
📋 סגנון: ${vibePrompts[vibeKey]}

⚡ הוראות קריטיות:
1. צור בדיוק 10 חוקים
2. כל חוק מקסימום 10 מילים
3. כתוב בעברית בלבד
4. פקודות ישירות (לא הסברים!)
5. החזר רשימת JSON של מחרוזות בלבד

דוגמה לפורמט תקין:
["השחקן הבא מדלג 2 תורות", "כל 7 - החלף כיוון"]

❌ אל תחזיר אובייקטים!
❌ אל תוסיף הסברים!
❌ אל תשתמש ב-markdown!

${hasImage ? '📸 נתח את המשחק בתמונה וצור חוקים מותאמים אליו.' : ''}
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
          "⚠️ תקלה ברשת",
          "בדוק חיבור אינטרנט",
          "נסה שוב"
        ]);
        setScreen('game');
      }
    } finally {
      setIsFetchingBatch(false);
      if (isInitial) setInitialLoading(false);
    }
  }, [API_KEY, customGameName, gameKey, imageData, isFetchingBatch, t.games, t.vibes, vibeKey, sanitizeRule]);

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
        setCurrentRule("טוען עוד נתונים...");
        fetchRulesBatch(false);
      }

      triggerGlitchEffect();
      setIsFlipped(true);
    }, 600);
  }, [isCoolingDown, isFetchingBatch, fetchRulesBatch, sanitizeRule]);

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
        setGameKey('camera');
        setCustomGameName('');
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setImageData(null);
    setGameKey('monopoly');
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
      
      <select 
        value={gameKey} 
        onChange={e => {
          const newKey = e.target.value;
          setGameKey(newKey);
          if (newKey !== 'camera') {
            setCustomGameName('');
          }
          if (newKey === 'camera') {
            fileInputRef.current?.click();
          }
        }} 
        dir="rtl"
      >
        {Object.keys(t.games).map(k => (
          <option key={k} value={k}>{t.games[k]}</option>
        ))}
      </select>

      {imageData && (
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
              left: 5,
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
      )}

      {!imageData && (
        <>
          <input
            type="text"
            placeholder={t.gameInputPlaceholder}
            value={customGameName}
            onChange={e => setCustomGameName(e.target.value)}
            className="neon-input"
            style={{
              width: '100%',
              padding: '12px',
              margin: '10px 0 10px 0',
              backgroundColor: '#222',
              border: '1px solid #00d4ff',
              color: '#fff',
              borderRadius: '8px',
              textAlign: 'right',
              fontSize: '1rem',
              outline: 'none',
              boxShadow: customGameName ? '0 0 10px #00d4ff' : 'none',
              transition: 'all 0.3s ease'
            }}
            dir="rtl"
          />
          
          <div 
            onClick={() => fileInputRef.current?.click()}
            style={{
              textAlign: 'center',
              color: '#00d4ff',
              marginBottom: 20,
              cursor: 'pointer',
              fontSize: '0.9rem',
              textDecoration: 'underline'
            }}
          >
            {t.scanPlaceholder}
          </div>
        </>
      )}

      <input 
        type="file" 
        ref={fileInputRef} 
        style={{display: 'none'}} 
        accept="image/*"
        onChange={handleImage}
      />
      
      <label>{t.chooseVibeLabel}</label>
      <select 
        value={vibeKey} 
        onChange={e => setVibeKey(e.target.value)} 
        dir="rtl"
      >
        {Object.keys(t.vibes).map(k => (
          <option key={k} value={k}>{t.vibes[k]}</option>
        ))}
      </select>
      
      <button 
        className="neon-btn" 
        onClick={startGame}
        disabled={initialLoading}
        style={{
          opacity: initialLoading ? 0.5 : 1,
          marginTop: 20
        }}
      >
        {initialLoading ? "מנתח נתונים..." : t.startGameBtn}
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
          {gameKey === 'camera' 
            ? 'משחק סרוק' 
            : (customGameName || t.games[gameKey])
          }
        </div>
      </div>
      
      <div className="flip-container">
        <div className={`flipper ${isFlipped ? 'flip-active' : ''}`}>
          <div className="front">
            {currentRule || t.rulePlaceholder}
          </div>
          <div className="back">
            {t.cardBackText}
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
          המערכת תופעל אוטומטית כל 45-90 שניות
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

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Қалталарды тексеру және жасау
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./public/sounds')) fs.mkdirSync('./public/sounds', { recursive: true });
if (!fs.existsSync('./public/assets')) fs.mkdirSync('./public/assets', { recursive: true });

// JSON файлдарын инициализациялау
if (!fs.existsSync('./data/tests.json')) {
  fs.writeFileSync('./data/tests.json', '[]');
}
if (!fs.existsSync('./data/sessions.json')) {
  fs.writeFileSync('./data/sessions.json', '{}');
}

// Файл жүктеу
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Файлды парсинг (формат: ? сұрақ \n + жауап \n - қате)
function parseTestFile(content) {
  const lines = content.split('\n');
  const questions = [];
  let currentQuestion = null;
  
  for (let line of lines) {
    line = line.trim();
    if (line === '') continue;
    
    if (line.startsWith('?')) {
      if (currentQuestion) questions.push(currentQuestion);
      // Сурет, дыбыс, бейне қолдау
      let text = line.substring(1).trim();
      let image = null;
      let audio = null;
      let video = null;
      
      const imgMatch = text.match(/\[img:([^\]]+)\]/);
      const audioMatch = text.match(/\[audio:([^\]]+)\]/);
      const videoMatch = text.match(/\[video:([^\]]+)\]/);
      
      if (imgMatch) {
        image = imgMatch[1];
        text = text.replace(imgMatch[0], '');
      }
      if (audioMatch) {
        audio = audioMatch[1];
        text = text.replace(audioMatch[0], '');
      }
      if (videoMatch) {
        video = videoMatch[1];
        text = text.replace(videoMatch[0], '');
      }
      
      currentQuestion = {
        text: text.trim(),
        options: [],
        correct: 0,
        image: image,
        audio: audio,
        video: video
      };
    } else if (line.startsWith('+') && currentQuestion) {
      currentQuestion.options.push(line.substring(1).trim());
      currentQuestion.correct = currentQuestion.options.length - 1;
    } else if (line.startsWith('-') && currentQuestion) {
      currentQuestion.options.push(line.substring(1).trim());
    }
  }
  if (currentQuestion) questions.push(currentQuestion);
  return questions;
}

function readTests() {
  try {
    const data = fs.readFileSync('./data/tests.json', 'utf-8');
    return data.trim() ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveTests(tests) {
  fs.writeFileSync('./data/tests.json', JSON.stringify(tests, null, 2));
}

function readSessions() {
  try {
    const data = fs.readFileSync('./data/sessions.json', 'utf-8');
    return data.trim() ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.writeFileSync('./data/sessions.json', JSON.stringify(sessions, null, 2));
}

// API: Тест жүктеу
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const filePath = path.join(__dirname, 'uploads', req.file.filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    const questions = parseTestFile(content);
    
    if (questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Файлда сұрақ табылмады' });
    }
    
    const testId = Date.now().toString();
    const newTest = {
      id: testId,
      name: req.body.name || req.file.originalname.replace('.txt', ''),
      questions: questions,
      createdAt: new Date().toISOString()
    };
    
    const tests = readTests();
    tests.push(newTest);
    saveTests(tests);
    fs.unlinkSync(filePath);
    
    res.json({ success: true, testId: testId, questionCount: questions.length });
  } catch (error) {
    console.error('Жүктеу қатесі:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Барлық тесттерді алу
app.get('/api/tests', (req, res) => {
  const tests = readTests();
  res.json(tests.map(t => ({ id: t.id, name: t.name, questionCount: t.questions.length })));
});

// API: Тестті алу
app.get('/api/test/:id', (req, res) => {
  const tests = readTests();
  const test = tests.find(t => t.id === req.params.id);
  if (test) {
    res.json(test);
  } else {
    res.status(404).json({ error: 'Табылмады' });
  }
});

// ============ SOCKET.IO ============
let activeSessions = {};

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
  console.log('Қосылды:', socket.id);
  
  // Админ сессия бастау
  socket.on('admin-create-session', (data) => {
    const { testId, settings } = data;
    const tests = readTests();
    const test = tests.find(t => t.id === testId);
    
    if (!test) {
      socket.emit('error', 'Тест табылмады');
      return;
    }
    
    const sessionCode = generateCode();
    const sessionId = Date.now().toString();
    
    let questions = [...test.questions];
    
    // Сұрақтарды таңдау (диапазон немесе кездейсоқ)
    let selectedQuestions = [];
    const qCount = test.questions.length;
    
    if (settings.questionRange) {
      const [start, end] = settings.questionRange.split('-').map(Number);
      selectedQuestions = questions.slice(start - 1, end);
    } else if (settings.randomCount) {
      const count = Math.min(parseInt(settings.randomCount), qCount);
      const shuffled = [...questions];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      selectedQuestions = shuffled.slice(0, count);
    } else {
      selectedQuestions = questions;
    }
    
    // Сұрақтарды араластыру (тек таңдалған диапазон бойынша)
    if (settings.shuffleQuestions === 'true' || settings.shuffleQuestions === true) {
      for (let i = selectedQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedQuestions[i], selectedQuestions[j]] = [selectedQuestions[j], selectedQuestions[i]];
      }
    }
    
    // Жауаптарды араластыру
    if (settings.shuffleAnswers === 'true' || settings.shuffleAnswers === true) {
      selectedQuestions = selectedQuestions.map(q => {
        const options = [...q.options];
        const correctText = options[q.correct];
        for (let i = options.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [options[i], options[j]] = [options[j], options[i]];
        }
        const newCorrectIndex = options.indexOf(correctText);
        return { ...q, options: options, correct: newCorrectIndex };
      });
    }
    
    const timeLimit = settings.timeLimit ? parseInt(settings.timeLimit) : 30;
    
    activeSessions[sessionCode] = {
      sessionId: sessionId,
      adminSocketId: socket.id,
      testId: testId,
      testName: test.name,
      settings: settings,
      questions: selectedQuestions,
      totalQuestions: selectedQuestions.length,
      participants: [],
      started: false,
      results: [],
      currentQuestionIndex: 0,
      timeLimit: timeLimit,
      createdAt: Date.now()
    };
    
    socket.join(sessionCode);
    socket.emit('session-created', { sessionCode, totalQuestions: selectedQuestions.length, sessionId });
    
    const sessions = readSessions();
    sessions[sessionCode] = {
      sessionId: sessionId,
      testId: testId,
      testName: test.name,
      settings: settings,
      questions: selectedQuestions,
      participants: [],
      started: false,
      createdAt: new Date().toISOString(),
      timeLimit: timeLimit
    };
    saveSessions(sessions);
  });
  
  // Сессияны қайта жүктеу (persistent)
  socket.on('reconnect-session', (data) => {
    const { sessionCode, participantName, participantId } = data;
    const session = activeSessions[sessionCode];
    const savedSessions = readSessions();
    const savedSession = savedSessions[sessionCode];
    
    if (!session && savedSession) {
      // Сессияны қалпына келтіру
      activeSessions[sessionCode] = {
        ...savedSession,
        adminSocketId: null,
        participants: savedSession.participants || [],
        started: savedSession.started || false,
        results: savedSession.results || [],
        currentQuestionIndex: savedSession.currentQuestionIndex || 0
      };
    }
    
    const active = activeSessions[sessionCode];
    if (active && participantName) {
      const existingParticipant = active.participants.find(p => p.name === participantName || p.id === participantId);
      if (existingParticipant) {
        existingParticipant.socketId = socket.id;
        socket.join(sessionCode);
        socket.emit('reconnect-success', {
          sessionCode,
          totalQuestions: active.totalQuestions,
          testName: active.testName,
          started: active.started,
          currentQuestionIndex: active.currentQuestionIndex,
          answers: existingParticipant.answers,
          timeLimit: active.timeLimit
        });
      } else if (!active.started) {
        const participant = {
          id: participantId || Date.now().toString(),
          socketId: socket.id,
          name: participantName,
          answers: new Array(active.totalQuestions).fill(null),
          startTime: null,
          endTime: null,
          score: null,
          currentIndex: 0
        };
        active.participants.push(participant);
        socket.join(sessionCode);
        socket.emit('reconnect-success', {
          sessionCode,
          totalQuestions: active.totalQuestions,
          testName: active.testName,
          started: active.started,
          currentQuestionIndex: 0,
          answers: participant.answers,
          timeLimit: active.timeLimit
        });
        io.to(sessionCode).emit('participants-update', 
          active.participants.map(p => ({ name: p.name, answered: p.answers.filter(a => a !== null).length, id: p.id }))
        );
      }
    } else if (active) {
      socket.join(sessionCode);
      socket.emit('session-info', {
        sessionCode,
        totalQuestions: active.totalQuestions,
        testName: active.testName,
        started: active.started,
        participantCount: active.participants.length
      });
    }
  });
  
  // Қолданушының қосылуы
  socket.on('participant-join', (data) => {
    const { sessionCode, name, participantId } = data;
    let session = activeSessions[sessionCode];
    const savedSessions = readSessions();
    const savedSession = savedSessions[sessionCode];
    
    if (!session && savedSession) {
      activeSessions[sessionCode] = {
        ...savedSession,
        adminSocketId: null,
        participants: savedSession.participants || [],
        started: savedSession.started || false,
        results: savedSession.results || []
      };
      session = activeSessions[sessionCode];
    }
    
    if (!session) {
      socket.emit('join-error', 'Код жарамсыз');
      return;
    }
    
    if (session.started) {
      socket.emit('join-error', 'Тест басталып кеткен');
      return;
    }
    
    const existingParticipant = session.participants.find(p => p.name === name);
    if (existingParticipant) {
      existingParticipant.socketId = socket.id;
      socket.join(sessionCode);
      socket.emit('join-success', { 
        sessionCode, 
        totalQuestions: session.totalQuestions,
        testName: session.testName,
        participantId: existingParticipant.id
      });
    } else {
      const participant = {
        id: participantId || Date.now().toString(),
        socketId: socket.id,
        name: name,
        answers: new Array(session.totalQuestions).fill(null),
        startTime: null,
        endTime: null,
        score: null,
        currentIndex: 0
      };
      
      session.participants.push(participant);
      socket.join(sessionCode);
      socket.participantData = { sessionCode, name: name };
      
      socket.emit('join-success', { 
        sessionCode, 
        totalQuestions: session.totalQuestions,
        testName: session.testName,
        participantId: participant.id
      });
      
      io.to(sessionCode).emit('participants-update', 
        session.participants.map(p => ({ name: p.name, answered: p.answers.filter(a => a !== null).length, id: p.id }))
      );
    }
    
    // Сессияны сақтау
    const sessions = readSessions();
    sessions[sessionCode] = {
      ...savedSession,
      participants: session.participants,
      started: session.started
    };
    saveSessions(sessions);
  });
  
  // Админ тестті бастау
  socket.on('admin-start-test', (data) => {
    const { sessionCode } = data;
    const session = activeSessions[sessionCode];
    
    if (session && session.adminSocketId === socket.id) {
      session.started = true;
      session.currentQuestionIndex = 0;
      const startTime = Date.now();
      
      session.participants.forEach(p => {
        p.startTime = startTime;
      });
      
      io.to(sessionCode).emit('test-started', { startTime, timeLimit: session.timeLimit });
      
      const sessions = readSessions();
      sessions[sessionCode] = {
        ...sessions[sessionCode],
        started: true,
        currentQuestionIndex: 0
      };
      saveSessions(sessions);
    }
  });
  
  // Админ келесі сұраққа өту
  socket.on('admin-next-question', (data) => {
    const { sessionCode } = data;
    const session = activeSessions[sessionCode];
    
    if (session && session.adminSocketId === socket.id) {
      session.currentQuestionIndex++;
      io.to(sessionCode).emit('next-question', {
        index: session.currentQuestionIndex,
        total: session.totalQuestions
      });
    }
  });
  
  // Сұрақ алу
  socket.on('get-question', (data) => {
    const { sessionCode, index } = data;
    const session = activeSessions[sessionCode];
    
    if (session && session.questions[index]) {
      const q = session.questions[index];
      socket.emit('question-data', {
        text: q.text,
        options: q.options,
        index: index,
        total: session.totalQuestions,
        timeLimit: session.timeLimit,
        image: q.image,
        audio: q.audio,
        video: q.video
      });
    }
  });
  
  // Жауап жіберу
  socket.on('submit-answer', (data) => {
    const { sessionCode, questionIndex, answerIndex, timeSpent } = data;
    const session = activeSessions[sessionCode];
    
    if (session && session.started) {
      const participant = session.participants.find(p => p.socketId === socket.id);
      if (participant) {
        participant.answers[questionIndex] = answerIndex;
        
        const answeredCount = participant.answers.filter(a => a !== null).length;
        const percentComplete = Math.round((answeredCount / session.totalQuestions) * 100);
        
        io.to(sessionCode).emit('participant-progress', {
          id: participant.id,
          name: participant.name,
          answered: answeredCount,
          total: session.totalQuestions,
          percent: percentComplete,
          currentIndex: questionIndex
        });
        
        // Барлығы аяқталғанын тексеру
        const allFinished = session.participants.every(p => p.answers.every(a => a !== null));
        if (allFinished && session.participants.length > 0) {
          const ranking = [...session.participants]
            .map(p => ({
              id: p.id,
              name: p.name,
              score: Math.round((p.answers.filter((a, idx) => a === session.questions[idx].correct).length / session.totalQuestions) * 100),
              correctCount: p.answers.filter((a, idx) => a === session.questions[idx].correct).length,
              timeSpent: p.endTime ? Math.floor((p.endTime - p.startTime) / 1000) : 0
            }))
            .sort((a, b) => {
              if (a.score !== b.score) return b.score - a.score;
              return a.timeSpent - b.timeSpent;
            });
          
          io.to(sessionCode).emit('all-finished', { ranking });
        }
      }
    }
  });
  
  // Тестті аяқтау
  socket.on('finish-test', (data) => {
    const { sessionCode } = data;
    const session = activeSessions[sessionCode];
    
    if (session) {
      const participant = session.participants.find(p => p.socketId === socket.id);
      if (participant && !participant.endTime) {
        participant.endTime = Date.now();
        
        let correctCount = 0;
        participant.answers.forEach((answer, idx) => {
          if (answer !== null && answer === session.questions[idx].correct) {
            correctCount++;
          }
        });
        participant.score = Math.round((correctCount / session.totalQuestions) * 100);
        
        const timeSpent = Math.floor((participant.endTime - participant.startTime) / 1000);
        
        // Жауаптарды толық талдау
        const answerDetails = participant.answers.map((ans, idx) => ({
          isCorrect: ans === session.questions[idx].correct,
          userAnswer: ans !== null ? session.questions[idx].options[ans] : null,
          correctAnswer: session.questions[idx].options[session.questions[idx].correct],
          questionText: session.questions[idx].text
        }));
        
        socket.emit('test-result', {
          score: participant.score,
          correctCount: correctCount,
          totalQuestions: session.totalQuestions,
          timeSpent: timeSpent,
          answers: answerDetails,
          rank: session.participants.filter(p => p.score > participant.score).length + 1,
          totalParticipants: session.participants.length
        });
        
        io.to(sessionCode).emit('participant-finished', {
          id: participant.id,
          name: participant.name,
          score: participant.score,
          correctCount: correctCount,
          totalQuestions: session.totalQuestions,
          timeSpent: timeSpent
        });
        
        // Барлығы аяқталғанын тексеру
        const allFinished = session.participants.every(p => p.endTime !== null);
        if (allFinished && session.participants.length > 0) {
          const ranking = [...session.participants]
            .map(p => ({
              id: p.id,
              name: p.name,
              score: p.score,
              correctCount: p.answers.filter((a, idx) => a === session.questions[idx].correct).length,
              timeSpent: Math.floor((p.endTime - p.startTime) / 1000)
            }))
            .sort((a, b) => {
              if (a.score !== b.score) return b.score - a.score;
              return a.timeSpent - b.timeSpent;
            });
          
          io.to(sessionCode).emit('all-finished', { ranking });
        }
      }
    }
  });
  
  // Толық статистика алу
  socket.on('get-full-stats', (data) => {
    const { sessionCode } = data;
    const session = activeSessions[sessionCode];
    
    if (session && session.adminSocketId === socket.id) {
      const fullStats = session.participants.map(p => ({
        name: p.name,
        score: p.score || Math.round((p.answers.filter((a, idx) => a === session.questions[idx].correct).length / session.totalQuestions) * 100),
        correctCount: p.answers.filter((a, idx) => a === session.questions[idx].correct).length,
        totalQuestions: session.totalQuestions,
        timeSpent: p.endTime ? Math.floor((p.endTime - p.startTime) / 1000) : null,
        answers: p.answers.map((ans, idx) => ({
          isCorrect: ans === session.questions[idx].correct,
          userAnswer: ans !== null ? session.questions[idx].options[ans] : null,
          correctAnswer: session.questions[idx].options[session.questions[idx].correct],
          questionText: session.questions[idx].text
        }))
      }));
      
      socket.emit('full-stats', { stats: fullStats, testName: session.testName });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Ажырады:', socket.id);
    
    for (const [code, session] of Object.entries(activeSessions)) {
      const participantIndex = session.participants.findIndex(p => p.socketId === socket.id);
      if (participantIndex !== -1) {
        session.participants[participantIndex].socketId = null;
        
        io.to(code).emit('participants-update', 
          session.participants.map(p => ({ name: p.name, answered: p.answers.filter(a => a !== null).length, id: p.id }))
        );
        break;
      }
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/game/:sessionCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/waiting/:sessionCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'waiting.html'));
});

app.get('/result/:sessionCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'result.html'));
});

// Static files
app.use(express.static('public'));

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     🎮 RAHOOT СТИЛІНДЕГІ ТЕСТ ПЛАТФОРМАСЫ 🎮            ║
╠══════════════════════════════════════════════════════════╣
║  Сервер істеді: http://localhost:${PORT}                    ║
║  Админ паролі: admin12344                               ║
║  Дыбыстар: /public/sounds/ қалтасына салыңыз            ║
║  Суреттер: /public/assets/ қалтасына салыңыз            ║
╚══════════════════════════════════════════════════════════╝
  `);
});
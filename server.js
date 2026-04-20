const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Ensure directories exist
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./uploads/temp')) fs.mkdirSync('./uploads/temp');

// Multer setup
const storage = multer.diskStorage({
    destination: './uploads/temp/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Database setup
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        manager_code TEXT,
        questions TEXT,
        settings TEXT,
        status TEXT DEFAULT 'waiting',
        current_question INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        game_id TEXT,
        player_name TEXT,
        score INTEGER DEFAULT 0,
        answers TEXT,
        current_question INTEGER DEFAULT 0,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS game_sessions (
        session_id TEXT PRIMARY KEY,
        game_id TEXT,
        is_active INTEGER DEFAULT 1,
        started_at DATETIME,
        ended_at DATETIME
    )`);
});

// Helper functions
function generateGameCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function parseQuestions(text) {
    const lines = text.split('\n');
    const questions = [];
    let currentQuestion = null;
    
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        if (line.startsWith('?')) {
            if (currentQuestion && currentQuestion.answers.length > 0) {
                questions.push(currentQuestion);
            }
            currentQuestion = {
                text: line.substring(1),
                answers: [],
                correctAnswer: null
            };
        } else if (line.startsWith('+') && currentQuestion) {
            const answer = line.substring(1);
            currentQuestion.answers.push(answer);
            currentQuestion.correctAnswer = answer;
        } else if (line.startsWith('-') && currentQuestion) {
            currentQuestion.answers.push(line.substring(1));
        } else if (currentQuestion) {
            return { error: 'Қате формат: ' + line };
        }
    }
    
    if (currentQuestion && currentQuestion.answers.length > 0 && currentQuestion.correctAnswer !== null) {
        questions.push(currentQuestion);
    }
    
    if (questions.length === 0) {
        return { error: 'Сұрақ табылмады' };
    }
    
    // Validate all questions have a correct answer
    const invalid = questions.find(q => q.correctAnswer === null);
    if (invalid) {
        return { error: 'Кейбір сұрақтарда дұрыс жауап (+) белгіленбеген: ' + invalid.text };
    }
    
    return { questions };
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/manager', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

app.get('/game/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.post('/api/join-game', (req, res) => {
    const { gameCode, playerName } = req.body;
    
    if (!gameCode || !playerName) {
        return res.json({ success: false, message: 'Барлық өрістерді толтырыңыз' });
    }
    
    db.get('SELECT * FROM games WHERE game_id = ?', [gameCode], (err, game) => {
        if (err || !game) {
            return res.json({ success: false, message: 'Мұндай ойын жоқ' });
        }
        
        const playerId = uuidv4();
        db.run('INSERT INTO players (player_id, game_id, player_name, score, answers, current_question) VALUES (?, ?, ?, ?, ?, ?)',
            [playerId, gameCode, playerName, 0, '[]', 0], (err) => {
            if (err) {
                return res.json({ success: false, message: 'Қате кетті' });
            }
            res.json({ success: true, playerId, gameCode });
        });
    });
});

app.post('/api/create-game', upload.single('questionFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: 'Файл жүктеңіз' });
        }
        
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const parseResult = parseQuestions(fileContent);
        
        fs.unlinkSync(req.file.path);
        
        if (parseResult.error) {
            return res.json({ success: false, message: parseResult.error });
        }
        
        let questions = parseResult.questions;
        const questionsRange = req.body.questionsRange;
        
        if (questionsRange && questionsRange !== 'all') {
            if (questionsRange === 'random') {
                const randomCount = parseInt(req.body.randomCount) || 50;
                questions = shuffleArray([...questions]).slice(0, Math.min(randomCount, questions.length));
            } else if (questionsRange.includes('-')) {
                const [start, end] = questionsRange.split('-').map(Number);
                questions = questions.slice(start - 1, end);
            }
        }
        
        if (req.body.shuffleQuestions === 'true') {
            questions = shuffleArray(questions);
        }
        
        if (req.body.shuffleAnswers === 'true') {
            questions = questions.map(q => ({
                ...q,
                answers: shuffleArray([...q.answers])
            }));
        }
        
        const gameId = generateGameCode();
        const managerCode = uuidv4();
        const settings = {
            timeLimit: parseInt(req.body.timeLimit) || 30,
            totalQuestions: questions.length
        };
        
        db.run('INSERT INTO games (game_id, manager_code, questions, settings, status) VALUES (?, ?, ?, ?, ?)',
            [gameId, managerCode, JSON.stringify(questions), JSON.stringify(settings), 'waiting'], (err) => {
            if (err) {
                return res.json({ success: false, message: 'Ойын құру қатесі' });
            }
            
            const gameUrl = `${req.protocol}://${req.get('host')}/game/${gameId}`;
            QRCode.toDataURL(gameUrl, (err, qrCode) => {
                res.json({ success: true, gameId, managerCode, qrCode, gameUrl });
            });
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/start-game', (req, res) => {
    const { gameId, managerCode } = req.body;
    
    db.get('SELECT * FROM games WHERE game_id = ? AND manager_code = ?', [gameId, managerCode], (err, game) => {
        if (err || !game) {
            return res.json({ success: false, message: 'Рұқсат жоқ' });
        }
        
        db.run('UPDATE games SET status = ? WHERE game_id = ?', ['active', gameId], (err) => {
            if (err) {
                return res.json({ success: false, message: 'Қате кетті' });
            }
            
            const sessionId = uuidv4();
            db.run('INSERT INTO game_sessions (session_id, game_id, started_at) VALUES (?, ?, ?)',
                [sessionId, gameId, new Date().toISOString()]);
            
            const questions = JSON.parse(game.questions);
            const settings = JSON.parse(game.settings);
            
            io.to(gameId).emit('game-started', { 
                questions: questions,
                settings: settings
            });
            
            res.json({ success: true });
        });
    });
});

app.post('/api/end-game', (req, res) => {
    const { gameId, managerCode } = req.body;
    
    db.get('SELECT * FROM games WHERE game_id = ? AND manager_code = ?', [gameId, managerCode], (err, game) => {
        if (err || !game) {
            return res.json({ success: false, message: 'Рұқсат жоқ' });
        }
        
        db.run('UPDATE games SET status = ? WHERE game_id = ?', ['ended', gameId], (err) => {
            if (err) {
                return res.json({ success: false, message: 'Қате кетті' });
            }
            
            io.to(gameId).emit('game-ended');
            res.json({ success: true });
        });
    });
});

app.post('/api/submit-answer', (req, res) => {
    const { playerId, gameId, questionIndex, answer, timeTaken } = req.body;
    
    db.get('SELECT * FROM games WHERE game_id = ?', [gameId], (err, game) => {
        if (err || !game) return res.json({ success: false });
        
        const questions = JSON.parse(game.questions);
        const question = questions[questionIndex];
        const isCorrect = answer === question.correctAnswer;
        const maxPoints = 1000;
        const points = isCorrect ? Math.max(0, maxPoints - (timeTaken * 10)) : 0;
        
        db.get('SELECT * FROM players WHERE player_id = ?', [playerId], (err, player) => {
            if (err || !player) return res.json({ success: false });
            
            let answers = [];
            try {
                answers = JSON.parse(player.answers || '[]');
            } catch(e) {
                answers = [];
            }
            
            answers.push({
                questionIndex,
                questionText: question.text,
                isCorrect,
                answer,
                correctAnswer: question.correctAnswer,
                points: Math.floor(points),
                timeTaken
            });
            
            const newScore = player.score + Math.floor(points);
            
            db.run('UPDATE players SET score = ?, answers = ?, current_question = ? WHERE player_id = ?',
                [newScore, JSON.stringify(answers), questionIndex + 1, playerId], (err) => {
                if (err) return res.json({ success: false });
                
                db.all('SELECT player_name, score FROM players WHERE game_id = ? ORDER BY score DESC LIMIT 5',
                    [gameId], (err, leaderboard) => {
                    io.to(gameId).emit('leaderboard-update', leaderboard);
                    res.json({ success: true, points: Math.floor(points), isCorrect });
                });
            });
        });
    });
});

app.get('/api/game-stats/:gameId', (req, res) => {
    const { gameId } = req.params;
    
    db.get('SELECT * FROM games WHERE game_id = ?', [gameId], (err, game) => {
        if (err || !game) return res.json({ success: false });
        
        db.all('SELECT * FROM players WHERE game_id = ? ORDER BY score DESC', [gameId], (err, players) => {
            if (err) return res.json({ success: false });
            
            const questions = JSON.parse(game.questions);
            const stats = players.map((player, index) => {
                let answers = [];
                try {
                    answers = JSON.parse(player.answers || '[]');
                } catch(e) {
                    answers = [];
                }
                
                return {
                    name: player.player_name,
                    score: player.score,
                    answers: answers,
                    rank: index + 1,
                    correctCount: answers.filter(a => a.isCorrect).length,
                    wrongCount: answers.filter(a => !a.isCorrect).length
                };
            });
            
            res.json({ success: true, stats, totalQuestions: questions.length });
        });
    });
});

app.get('/api/check-game-status/:gameId', (req, res) => {
    const { gameId } = req.params;
    
    db.get('SELECT status, current_question FROM games WHERE game_id = ?', [gameId], (err, game) => {
        if (err || !game) {
            return res.json({ success: false });
        }
        res.json({ success: true, status: game.status, currentQuestion: game.current_question });
    });
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('Жаңа қосылым:', socket.id);
    
    socket.on('join-game-room', (gameCode) => {
        socket.join(gameCode);
        socket.gameCode = gameCode;
        console.log(`Ойыншы ${socket.id} ${gameCode} кодына қосылды`);
        
        db.get('SELECT status, current_question, questions, settings FROM games WHERE game_id = ?', [gameCode], (err, game) => {
            if (err || !game) return;
            
            socket.emit('game-status', { 
                status: game.status,
                currentQuestion: game.current_question
            });
            
            if (game.status === 'active') {
                const questions = JSON.parse(game.questions);
                const settings = JSON.parse(game.settings);
                socket.emit('game-started', { questions, settings });
            }
        });
    });
    
    socket.on('next-question', (data) => {
        const { gameId, managerCode, questionIndex } = data;
        
        db.get('SELECT * FROM games WHERE game_id = ? AND manager_code = ?', [gameId, managerCode], (err, game) => {
            if (err || !game) return;
            
            db.run('UPDATE games SET current_question = ? WHERE game_id = ?', [questionIndex, gameId]);
            
            const questions = JSON.parse(game.questions);
            const settings = JSON.parse(game.settings);
            
            io.to(gameId).emit('new-question', {
                question: questions[questionIndex],
                questionNumber: questionIndex + 1,
                totalQuestions: questions.length,
                timeLimit: settings.timeLimit
            });
        });
    });
    
    socket.on('disconnect', () => {
        console.log('Қосылым үзілді:', socket.id);
        if (socket.gameCode) {
            socket.leave(socket.gameCode);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Сервер іске қосылды: http://localhost:${PORT}`);
    console.log(`📊 Менеджер панелі: http://localhost:${PORT}/manager`);
    console.log(`🎮 Ойын беті: http://localhost:${PORT}`);
});
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();

// Environment variables with defaults
const port = process.env.PORT || 3000;
const nodeEnv = process.env.NODE_ENV || 'development';
const domain = process.env.DOMAIN || `http://localhost:${port}`;


// Production security middleware
if (nodeEnv === 'production') {
    const helmet = require('helmet');
    app.use(helmet());
}

// Telegram Bot setup
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(telegramToken, { polling: true,
    // Add webhook support for production
    webHook: nodeEnv === 'production' ? {
        port: port
    } : false
});

// Google Calendar API setup
const REDIRECT_URI = 'http://localhost:3000';  // Changed: Using root path only
const oauth2Client = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: REDIRECT_URI
});

// Store user tokens (In production, use a proper database)
const userTokens = new Map();

// Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Generate Google Calendar authentication URL
function getAuthUrl(chatId) {
    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        state: chatId.toString(),
        prompt: 'consent'
    });
}

// Check upcoming events for a user
async function checkUpcomingEvents(chatId, auth) {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    try {
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: oneHourFromNow.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items;
        if (events.length) {
            events.forEach(event => {
                const startTime = new Date(event.start.dateTime || event.start.date);
                const message = `Upcoming event: ${event.summary}\nStarts at: ${startTime.toLocaleString()}`;
                bot.sendMessage(chatId, message);
            });
        }
    } catch (error) {
        console.error('Error fetching calendar events:', error);
        bot.sendMessage(chatId, 'Error fetching your calendar events.');
    }
}

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const authUrl = getAuthUrl(chatId);
    bot.sendMessage(chatId,
        'Welcome! Please authorize the bot to access your Google Calendar:\n' +
        `${authUrl}\n\n` +
        'After authorization, you will receive notifications for upcoming events.'
    );
});

// Handle the OAuth callback at root path
app.get('/', async (req, res) => {
    const { code, state } = req.query;

    // If no code is present, show a simple welcome message
    if (!code) {
        res.send('Welcome to Telegram Calendar Bot');
        return;
    }

    const chatId = state;

    try {
        const { tokens } = await oauth2Client.getToken(code);
        userTokens.set(chatId, tokens);

        // Send success message to user
        bot.sendMessage(chatId, 'Successfully connected to your Google Calendar! You will now receive notifications for upcoming events.');

        // Set up calendar checking for this user
        const auth = new OAuth2Client({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: REDIRECT_URI
        });
        auth.setCredentials(tokens);

        // Initial check
        checkUpcomingEvents(chatId, auth);

        // Set up periodic checks
        setInterval(() => {
            if (userTokens.has(chatId)) {
                const auth = new OAuth2Client({
                    clientId: process.env.GOOGLE_CLIENT_ID,
                    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                    redirectUri: REDIRECT_URI
                });
                auth.setCredentials(userTokens.get(chatId));
                checkUpcomingEvents(chatId, auth);
            }
        }, 5 * 60 * 1000); // Check every 5 minutes

        res.send('Authorization successful! You can close this window.');

    } catch (error) {
        console.error('Error getting tokens:', error);
        res.status(500).send('Authorization failed');
        if (chatId) {
            bot.sendMessage(chatId, 'Failed to connect to Google Calendar. Please try again with /start');
        }
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.info('SIGTERM signal received.');
    console.log('Closing HTTP server...');
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});

// Start server
const server = app.listen(port, () => {
    console.log(`Server running in ${nodeEnv} mode on ${domain}`);
    console.log('Telegram bot is active');
});

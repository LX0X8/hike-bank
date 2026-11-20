# HIKE BANK

HIKE BANK is a virtual DSMP game-credit ledger. It is not a real bank and does not process real-money deposits or payments.

## Features

- Player registration and login
- PostgreSQL-backed accounts, balances, and transaction history
- Deposit requests that require admin approval
- Player withdrawals from virtual credits
- Admin tools to add or remove credits by username
- Automatic +500,000 player credit reward every 48 hours
- Optional Discord DM notification when a player withdraws
- Password hashing, server-side sessions, rate limits, and security headers

## Render deployment

1. Create a PostgreSQL database in Render.
2. Copy its **Internal Database URL** into the web service environment variable `DATABASE_URL`.
3. Set `SESSION_SECRET` to a random secret of at least 32 characters.
4. Set `ADMIN_USERNAME` to `ADMIN`.
5. Set `ADMIN_PASSWORD` to a new, private password before launch. The requested initial password is `hike223`, but do not keep it for a public deployment.
6. Set `NODE_ENV` to `production`.
7. Build command: `npm install`
8. Start command: `npm start`

The application creates its database tables at startup. Keep the PostgreSQL database; the free web service filesystem is not persistent.

## Discord notifications

Create a Discord bot and enable the bot's ability to send messages. Add these Render environment variables:

- `DISCORD_BOT_TOKEN`: the bot token (keep it secret)
- `DISCORD_USER_ID`: the recipient's numeric Discord user ID

The bot must be allowed to open a DM with the recipient. If either variable is missing, withdrawals still work but the notification is skipped and logged.

## Credit rules

Each non-admin player receives 500,000 credits per 48-hour interval. Rewards are applied safely when the player next accesses their account; missed intervals accumulate. Deposits are requests and only add credits after an admin approves them. Withdrawals immediately subtract virtual credits.

## Local development

1. Install Node.js 20 or newer and PostgreSQL.
2. Copy `.env.example` to `.env` and fill in the values.
3. Run `npm install`.
4. Run `npm start`.
5. Open http://localhost:10000.
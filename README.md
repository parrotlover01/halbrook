# Halbrook

The true cost of AI, in plain sight. Live at [halbrook.xyz](https://www.halbrook.xyz).

- **Exchange**: every AI model has a reference price (what it really costs to use, from the hosts) and a market price set by players. Swap between models; the premium moves with trades, within ±30% of the reference.
- **Aggregator**: one balance for every model. Chat or call the OpenAI-compatible API (`https://www.halbrook.xyz/v1`); each request goes to the cheapest host and costs what it really cost. Switch models mid-conversation, with one shared memory.
- **The film**: the home page is a short interactive film. Find the code to open the briefcase.

## Run it

```bash
npm install
DATABASE_URL=postgres://… SESSION_SECRET=… node server.js
```

Settings are environment variables, never files:

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `SESSION_SECRET` | Signs sessions and encrypts the shared memory |
| `OPENROUTER_API_KEY` | Routing for chat and API |
| `TEST_MODE=1` | Free test credit, no real money |
| `TREASURY_ADDRESS`, `TREASURY_PRIVATE_KEY`, `WITHDRAWALS_ENABLED=1`, `ADMIN_TOKEN` | Real USDG deposits and withdrawals on Robinhood Chain (off in test mode) |

Halbrook runs on real USDG deposits on Robinhood Chain. Start small. Nothing here is investment advice.

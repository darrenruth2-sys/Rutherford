# Changelog

## 20.0.0: The coder upgrade

**Works like a real engineer now**
- **Runs your code and fixes it.** Rutherford can run commands in your project (tests, builds, `npm install`, your app), read the real errors, fix them, and run again until it works. It asks first, showing exactly what it wants to run. Choose **Allow**, **Allow all in this chat** or **Don't run**. Settings can let tests/builds run without asking.
- **🔨 Build mode** (button next to Think): plans the job as a checklist, builds one step at a time, tests each step, and keeps going. Edits apply right away (each has Undo, plus save points). The plan is saved in the project, so **Continue build** picks it back up later, even in a new chat.
- **Knows your project:** a map of every code file and its functions, your library versions, and **RUTHERFORD.md** (your rules for the project, which it follows and keeps up to date).
- **Learns lessons:** bugs it figured out are saved per project, so it doesn't repeat them.
- **👁 Eyes:** opens your page or game in a hidden Edge/Chrome, clicks and presses keys like a player, takes a screenshot, catches JavaScript errors, and a vision brain describes what's actually on screen. It checks its own previews before saying it's done.
- **🔍 Second opinion:** after code changes, a *different* AI brain reviews them for real bugs. If it finds any, Rutherford fixes them in the same answer.
- **⏱ Save points:** snapshots of your whole project (Git under the hood, kept local). Made automatically before and after changes. **Go back** to any of them from the top bar; going back can itself be undone. Never includes `node_modules` or `.env` secrets.
- **Coding brains:** each AI provider gets a coding model (e.g. Gemini Pro, Qwen Coder on NVIDIA) used when a project is open or in Build mode. It falls back to the normal one when it hits its limit. Change them in Settings.

**More tools**
- **Python runner:** exact homework math (fractions, sympy), stats and data, and **charts** that show up in the chat. Runs in a scratch folder with guard rails (no deleting your files, no internet, no starting programs).
- **Live docs:** looks up the current version and docs of any npm or Python library, so it doesn't write outdated code.
- **🎤 Voice typing** (on the computer): talk, and it types (Groq Whisper). Phones: use your keyboard's mic.

**Personality**
- Talks to you like an adult: casual and direct, no lectures or disclaimers, swearing OK.
- **Custom instructions** in Settings: tell it how to talk and act.
- Answers just say **Rutherford**. Which brain answered is in the ⓘ next to Copy.

**Fixes**
- Two pending edits to the same file now combine into one change, instead of the second failing.

## 19.1.0: Phone access fixes
- The phone QR code now uses this computer's **real Wi-Fi address** (the one it uses to reach the internet). Virtual adapters from Hyper-V, WSL, VirtualBox, Docker and VPNs are hidden, because a phone can't reach them.
- **Test** button in Settings → 📱 Phone access: checks every address answers and shows ✓ or ✗.
- Clearer help when it won't load (Wi-Fi set to Private, firewall), and a note that your router can change the address.

## 19.0.0: Free-brain chain, Think harder, code runner

- **Free AI brains:** Groq, Google Gemini, NVIDIA and OpenRouter's free models. Add any keys in Settings → 🧠 Free AI brains. Rutherford uses them in your order and **switches automatically** when one hits its free limit or is down. A tired provider rests for a while, and you can see it in Settings.
- **Usage meter:** answers and tokens per provider today; each answer shows which brain wrote it.
- **🧠 Think harder** button: asks the model to reason longer (slower, better on tough bugs, math, planning). Falls back cleanly if a provider doesn't support it.
- **Code runner:** the AI can run JavaScript to do exact math, test logic and crunch data instead of guessing. It runs in a locked-down process: no file access, can't start programs, 10-second limit. You see the code and the output in the chat.
- Photos work with Gemini too (no Groq key needed).
- Web search still uses your Groq key (Groq's built-in search).

## 18.0.0: Real money (with guardrails), Rutherford's Picks, phone access

**Real $ tab (Alpha)**
- Copy one bot's crypto and stock trades into your **Alpaca** account. **Practice** (Alpaca paper) or **Real money** (Alpaca live, separate keys, typed confirmation).
- **Ask-me-first** mode (default): every order waits for your Approve and expires after 10 minutes. Or **Automatic** within limits.
- Limits enforced on the server: total budget, max per trade, daily loss limit (auto shut-off), max orders per day, crypto/stocks switches, hold stocks overnight to avoid day-trade limits.
- Only sells what Rutherford bought. Your own holdings are never touched.
- Every order has a unique ID: a lost reply is looked up, never resent (no double orders).
- Kill switch cancels Rutherford's open orders and turns everything off. "Sell everything Rutherford bought" button.
- Polymarket is never traded with real money (not allowed for Ohio residents).

**Rutherford's Picks (Predictions tab)**
- 🔮 Ask Rutherford on any market: it searches the web (news, injuries, form) and gives its own odds, a pick, confidence, reasons and sources. It flags **value** when an outcome looks underpriced.
- **Pick top 5** researches the biggest markets on screen.
- Track record: every pick is scored when the market resolves, against the market's own odds (accuracy + Brier score).
- The AI bot (Nucleus) sees Rutherford's picks.

**Phone access**
- Settings → Phone access: use Rutherford (chat + Alpha) on your phone over home Wi-Fi with a QR code and a 6-digit PIN. Works away from home with Tailscale.
- Add to Home Screen support (app icon + full-screen).
- Phones can't see the PIN or change phone access; 5 wrong PINs lock that device out for 10 minutes.

**Other**
- Stocks fall back to Yahoo automatically if Alpaca data has a problem; "Save & test" tells you honestly if the keys failed.

## 17.0.0: Web, images, Library, and the Bot Arena

**Chat (Rutherford)**
- **Web search + read web pages.** Uses Groq's built-in browser search (no extra key). Sources show as links under the answer. Can be switched off in Settings.
- **Make images.** "make me a picture of…" uses Pollinations: free without a key (about 1 per 15s); add a free token in Settings for more.
- **Library.** Your own knowledge base: add PDFs, Word docs, text, code, web pages or a whole folder. Rutherford searches it (locally, BM25 ranking) when your question could be answered from it, and cites the document and page.

**Alpha (markets)**
- **Stocks.** Uses Alpaca (free account, add keys in Alpha Settings) or Yahoo's public feed until then. Knows market hours.
- **Predictions.** Live Polymarket odds (trending, sports, 15-minute crypto, crypto, politics, search) with paper bets, early cash-out, and automatic payout when markets resolve.
- **Bot Arena.** Four paper bots, Proton (momentum), Electron (contrarian), Neutron (trend) and Nucleus (AI), each with its own money, trading crypto, stocks and Polymarket.
  - Full stats: return, win rate (with a coin-flip test), avg win/loss, profit factor, max drawdown, best/worst trade, fees, and a complete trade log with reasons.
  - **Learning:** on a schedule the weakest rule bot moves its settings toward the leader's (with small mutations). The AI bot reads the leaderboard and a shared lesson log every round. Everything is written to the Learning log.
  - Equity chart vs simply holding Bitcoin.
- Default crypto fee is now 0.25% (Alpaca's rate).

Still paper-only. Real-money trading is not built.

## 16.1.0: Alpha inside Rutherford
- Alpha (markets, paper trading, forecast lab, Ask Alpha) now runs inside Rutherford. Switch with the rail on the left (or Alt+1 / Alt+2). On phones, use the **◈ Alpha** chip and **‹ Chat** to switch.
- One launcher, one window, one Groq key. Alpha's forecasts keep scoring while Rutherford is open.
- Alpha's code lives in `apps/alpha/` with its own server routes, UI and tests, mounted at `/alpha/`.

## 16.0.0 — Clean rebuild

A fresh, chat-first Rutherford. It replaces V15.5 (about 280 files, 18 stacked CSS files and 85 API routes) with one screen and a small, tested core.

**New**
- One chat screen. Tools run *inside* the chat (the AI decides when to read files, search, propose edits, or show a preview) instead of 400+ buttons.
- Real streaming answers, up to 8k tokens (V15 capped replies at 1,200 tokens).
- Multi-step tool use: up to 12 steps per answer (V15 allowed one read-only tool).
- Code edits: proposed as a diff card → **Apply** → **Undo**, with checkpoints. Refuses to apply if the file changed underneath, and refuses to undo over your own later edits.
- Attachments: PDF (text, or page images for scans), Word .docx, images, and any text or code file. Paste or drag-drop.
- Photos automatically use the vision model.
- Live HTML preview panel with download (replaces Genesis SiteForge).
- Memory: the AI can save facts, and you can edit them in Settings.
- Markdown, code highlighting with Copy, math (KaTeX), tables.
- Works on phone-size screens.
- Settings and chats are stored in your user profile, so updates don't wipe them.

**Removed from this app**
- Markets / TradePilot / forecasting / quotes: moved to their own app, **Rutherford Alpha**.
- Helium/Ion/Optium modes, the Workspace dropdown, Genesis tabs, plugin marketplace, the "ten tools" panels and all versioned CSS/JS layers. Their useful parts are now tools the AI can call.

**Fixed**
- V15.0–15.5 stylesheets and `tradepilot-policy.js` never loaded, because the server's hard-coded file allowlist didn't include them. The new server serves everything in `public/`, and a test checks that every file the page references loads with the right type.

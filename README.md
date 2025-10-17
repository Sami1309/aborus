
<img width="248" height="106" alt="Screenshot 2025-10-17 at 1 45 28 AM" src="https://github.com/user-attachments/assets/6352c73e-3519-4e99-b3d0-8065d5a32b09" />


**Dead-simple AI browser automation to speedily deploy workflows at scale**


<img width="1473" height="702" alt="Screenshot 2025-10-17 at 1 43 19 AM" src="https://github.com/user-attachments/assets/108e812f-e886-4750-83fc-0a108381a3eb" />

---

## Why Aborus?

Traditional browser automation breaks when UI changes. Aborus uses a mixture of DOM-selectors for speed, and browser-use AI scaffolding to fill in the gaps for the best of both worlds, adapting seamlessly to any task in any environment.

- **Record naturally** — Browse normally while Aborus captures your actions
- **Natural-language workflow generator** — Analyze recordings to generate structured automation flows
- **Hybrid execution** — Run deterministically for speed, fall back to AI when needed
- **Self-healing** — Automatically adapts to UI changes without manual intervention

---

## Quick Start

### Prerequisites

- Python 3.11+
- Chrome browser
- OpenAI/Anthropic API key (for AI features)

### 1. Install Dependencies

```bash
# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install Python packages
pip install -r agent/requirements.txt
```

### 2. Configure API Keys

Create a `.env` file in the project root:

```bash
# For Claude Sonnet 4.5 (recommended)
ANTHROPIC_API_KEY=your_anthropic_key

# Or for OpenAI models
OPENAI_API_KEY=your_openai_key
```

### 3. Install Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project

You should see "Modeler Recorder Monitor" appear in your extensions.

### 4. Start the Server

```bash
python3 -m agent.modeler.cli serve --host 127.0.0.1 --port 8001
```

The dashboard will be available at: **http://127.0.0.1:8001/web/dashboard**

---

## How to Use Aborus

### Step 1: Record a Workflow

1. Open the dashboard at http://127.0.0.1:8001/web/dashboard
2. Navigate to the **Record** tab
3. Enter the URL where you want to start recording (e.g., `https://example.com`)
4. Click **Start Recording**
5. A new browser tab opens — perform your workflow normally
6. The extension captures all interactions automatically (clicks, inputs, navigation)

### Step 2: Generate a Flowchart

1. Go to the **Flowchart** tab
2. Select your recording from the dropdown
3. Click **Generate with Claude** to analyze the recording
4. Claude Sonnet 4.5 converts your actions into a structured automation flow
5. Review each step:
   - View captured DOM selectors
   - Adjust execution mode (Deterministic / LLM / Hybrid)
   - Edit steps using natural language

### Step 3: Save as Automation

1. In the **Flowchart** tab, give your automation a name
2. Choose the default execution engine:
   - **Deterministic**: Fast, uses DOM selectors (recommended for stable UIs)
   - **LLM**: AI-powered, adapts to changes (slower, uses API credits)
   - **Hybrid**: Mix of both approaches
3. Click **Save Automation**

### Step 4: Run Your Automation

1. Navigate to the **Automations** tab
2. Find your saved automation
3. Click **Run** to execute it in a new browser session
4. Monitor progress in the **Runs** tab
5. View execution logs, screenshots, and results

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Dashboard (Web UI)                     │
│              Record → Analyze → Automate → Run              │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ REST API
                             │
┌────────────────────────────▼────────────────────────────────┐
│              Python FastAPI Service (Port 8001)             │
│  • Session management    • AI integration (Claude)          │
│  • Schema generation     • Automation orchestration         │
│  • Run execution         • Storage (JSON files)             │
└────────────────────────────┬────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
      ┌─────────▼─────────┐    ┌─────────▼──────────┐
      │ Chrome Extension  │    │  browser-use Agent │
      │ • Event capture   │    │  • AI execution    │
      │ • Run monitoring  │    │  • Self-healing    │
      └───────────────────┘    └────────────────────┘
```

---

## Key Features

### Intelligent Recording
- **Zero instrumentation** — No code changes to target websites
- **Automatic schema extraction** — Understands page structure and interactions
- **Rich context capture** — DOM selectors, element attributes, page state

### AI-Powered Analysis
- **Claude Sonnet 4.5** — State-of-the-art reasoning for workflow understanding
- **Natural language editing** — "Make this step wait for the loading spinner"
- **Step optimization** — Identifies redundant actions and suggests improvements

### Production-Ready Execution
- **Multiple execution modes** — Choose speed vs. adaptability
- **Detailed run logs** — Debug failures with complete execution history
- **Scalable architecture** — Run multiple automations concurrently

---

## Use Cases

- **QA Testing**: Record test scenarios once, replay across deployments
- **Data Collection**: Automate web scraping with adaptive selectors
- **Workflow Automation**: Automate repetitive browser tasks (form filling, reporting)
- **Monitoring**: Detect when user flows break due to UI changes

---

## Project Structure

```
aborus/
├── agent/                  # Python backend
│   ├── modeler/           # Core automation engine
│   │   ├── cli.py         # CLI entry point
│   │   ├── service.py     # FastAPI service
│   │   ├── llm.py         # AI integration
│   │   └── ...
│   └── requirements.txt
├── extension/             # Chrome extension
│   ├── manifest.json
│   ├── background.js      # Extension service worker
│   └── content.js         # Page instrumentation
├── web/                   # Web dashboard
│   └── dashboard/
│       ├── dashboard.html
│       └── dashboard.js
└── storage/               # Persisted data
    ├── recordings/        # Raw browser events
    ├── schemas/           # Extracted schemas
    ├── flowcharts/        # AI-generated flows
    ├── automations/       # Saved automations
    └── runs/              # Execution history
```

---

## Configuration

Advanced options can be configured in `.env`:

```bash
# API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Server Configuration
HOST=127.0.0.1
PORT=8001

# AI Model Selection
LLM_PROVIDER=anthropic  # or 'openai'
LLM_MODEL=claude-sonnet-4.5  # or 'gpt-4'

# Execution Settings
MAX_STEPS=50
STEP_TIMEOUT=30000
```

---

## Development

### Running Tests

```bash
pytest tests/
```

### CLI Commands

```bash
# Start API server
python3 -m agent.modeler.cli serve --host 127.0.0.1 --port 8001

# Export flow graph from events
python3 -m agent.modeler.cli export storage/recordings/SESSION_ID.json --out flow.json
```

---

## Roadmap

- [ ] Multi-browser support (Firefox, Safari)
- [ ] Webhook integrations for CI/CD pipelines
- [ ] Team collaboration features (shared automations)
- [ ] Cloud execution platform (no local browser required)
- [ ] Visual flowchart editor with drag-and-drop
- [ ] Advanced scheduling and triggers

---

## Technical Details

**Built with:**
- **Backend**: FastAPI (Python), browser-use agent framework
- **AI**: Claude Sonnet 4.5 via Anthropic API
- **Browser**: Chrome DevTools Protocol, Playwright
- **Storage**: JSON file-based (easily portable to DB)

**Execution Modes:**
- **Deterministic**: Replays using captured DOM selectors (fast, cheap)
- **LLM**: AI agent navigates based on intent (robust, adaptive)
- **Hybrid**: Uses selectors when available, falls back to AI on failure

---

## License

MIT

---

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/aborus/issues)
- **Documentation**: See `SPEC.md` for architecture details
- **Discord**: [Join our community](#) (coming soon)

---

**Built for YC W25** | Making browser automation intelligent and reliable

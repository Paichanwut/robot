# Robot Monitor 🤖

A lightweight, real-time website status monitoring dashboard. It periodically pings target URLs, measures response latency, calculates uptime statistics, and keeps a log of state transitions (ONLINE / OFFLINE) directly in the browser dashboard.

![Robot Monitor Dashboard](https://github.com/Paichanwut/robot/raw/main/screenshot.png) *(Note: Please place a screenshot here once pushed)*

## Key Features

- **Dynamic Polling Schedulers**: Set polling intervals (10s, 30s, 1m, 5m, 15m, 1h) individually per website.
- **In-App Activity Logs**: Instant visual alerts and historical log records when a site changes status.
- **Latency Sparklines**: A neat visual history of response times for the last 20 checks.
- **Zero-Config Database**: Fast, lightweight local file storage (`server/data/db.json`) that works out of the box with zero setup required.
- **Premium Glassmorphic Design**: Clean responsive layout, full dark-theme styling, status pulse indicators, and fluid CSS transitions.

## Tech Stack

- **Frontend**: React, Vite, Vanilla CSS.
- **Backend**: Node.js, Express.
- **Communication**: Express REST APIs + polling.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm (Node Package Manager)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Paichanwut/robot.git
   cd robot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Application

#### 🚀 Development Mode

Runs both the frontend dev server (Vite on port `5173`) and the backend API server (Express on port `3001`) concurrently:
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

#### 📦 Production Mode

Build the optimized production assets for the frontend, and run the unified Express server:
```bash
npm run build
npm start
```
Open [http://localhost:3001](http://localhost:3001) in your browser (Express serves both APIs and built static frontend files).

## Project Structure

```text
robot/
├── index.html                 # Main HTML file
├── package.json               # Project dependencies and script runner
├── vite.config.js             # Vite configuration
├── src/                       # Frontend React code
│   ├── main.jsx               # React DOM entry point
│   ├── App.jsx                # Main dashboard UI
│   ├── index.css              # Global variables & variables resets
│   └── App.css                # Glassmorphic component styles & layouts
└── server/                    # Backend Express code
    ├── index.js               # Main Express listener and background ping engine
    └── data/                  # Git-ignored directory
        └── db.json            # Local JSON database (auto-generated)
```

## License

MIT License.

"use client";

import {
  ArrowRight,
  BookOpenText,
  Check,
  CheckCircle,
  ClipboardText,
  Code,
  Cpu,
  DeviceMobile,
  DownloadSimple,
  HandTap,
  Package,
  Play,
  Robot,
  ShieldCheck,
  TerminalWindow,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import styles from "./docs.module.css";

const API_BASE = "http://127.0.0.1:3013";

const nav = [
  ["start", "Quick start"],
  ["connect", "Connect hardware"],
  ["calibrate", "Home & calibrate"],
  ["first-tap", "First tap"],
  ["rest", "REST API"],
  ["agent", "Connect an Agent"],
  ["actions", "Action reference"],
  ["safety", "Safety"],
  ["troubleshooting", "Troubleshooting"],
] as const;

function CodeBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className={styles.codeBlock}>
      <div><span>{label}</span><button type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <ClipboardText size={14} />}{copied ? "Copied" : "Copy"}</button></div>
      <pre>{value}</pre>
    </div>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <div className={styles.step}>
      <span>{number}</span>
      <div><h3>{title}</h3>{children}</div>
    </div>
  );
}

export function DocsContent() {
  const [agentGuideCopied, setAgentGuideCopied] = useState(false);
  const installer = `curl -fsSL --proto '=https' --tlsv1.2 \\
  https://screenhand-remote-console.alhazaranwar205.chatgpt.site/install.sh | bash`;
  const sourceSetup = `git clone https://github.com/alhazar0/screenhand-control-console.git
cd screenhand-control-console
./scripts/setup-macos.sh
npm run local`;
  const listDevices = `curl ${API_BASE}/api/v1/devices`;
  const mcpConfig = `{
  "mcpServers": {
    "screenhand": {
      "command": "screenhand",
      "args": ["mcp"],
      "env": {
        "SCREENHAND_API_URL": "${API_BASE}"
      }
    }
  }
}`;
  const agentPrompt = `Use ScreenHand to operate the connected phone.
Always list devices and read capabilities first.
Before every coordinate action, get a fresh screenshot.
Use the exact frameSequence, frameWidth, and frameHeight returned with that screenshot.
Do not bypass a locked capability. Report the reason to me.
Never home the arm unless I confirm the physical workspace is clear.`;
  const copyAgentGuide = async () => {
    const response = await fetch("/agent-guide.txt", { cache: "no-store" });
    if (!response.ok) throw new Error("Agent guide is unavailable");
    await navigator.clipboard.writeText(await response.text());
    setAgentGuideCopied(true);
    window.setTimeout(() => setAgentGuideCopied(false), 1_500);
  };
  const tapRequest = `curl -X POST ${API_BASE}/api/v1/devices/black-arm-01/actions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "idempotencyKey": "checkout-test-step-1",
    "action": {
      "type": "tap",
      "point": { "x": 360, "y": 780 },
      "viewport": { "width": 720, "height": 1560 },
      "frameSequence": 123
    }
  }'`;

  return (
    <main className={styles.docs} lang="en">
      <header className={styles.header}>
        <Link className={styles.brand} href="/docs"><span><Robot size={21} weight="fill" /></span><strong>ScreenHand</strong><em>Docs</em></Link>
        <nav><a href="http://127.0.0.1:3012">Dashboard</a><a href="/agent-guide.txt" target="_blank" rel="noreferrer">Agent handoff</a><a href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a><a className={styles.headerCta} href="http://127.0.0.1:3012">Open local app <ArrowRight size={14} /></a></nav>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <span>GET STARTED</span>
          {nav.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}
          <div className={styles.sidebarStatus}><span /><div><strong>Black arm platform</strong><small>macOS · local-first</small></div></div>
        </aside>

        <article className={styles.content}>
          <section className={styles.hero} id="start">
            <div className={styles.eyebrow}><BookOpenText size={16} /> Developer documentation</div>
            <h1>Install once.<br />Control a real phone.</h1>
            <p>One command installs the local runtime and starts guided onboarding. Then use the Dashboard, REST API, or MCP from your own software and Agent.</p>
            <div className={styles.heroActions}><a href="#connect">Start setup <ArrowRight size={15} /></a><a href="/downloads/screenhand-macos.tgz" download>Download for macOS</a><a href="#agent">Connect an Agent</a></div>
            <div className={styles.truthBar}><CheckCircle size={18} weight="fill" /><span><strong>One rule:</strong> the Dashboard, API, and MCP use the same hardware safety gates. No integration can skip calibration or reach beyond the verified phone area.</span></div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><Package size={22} /><div><span>BEFORE YOU START</span><h2>What you need</h2></div></div>
            <div className={styles.requirements}>
              <div><Robot size={22} /><strong>ScreenHand black arm</strong><span>Controller, stylus, power supply, and USB cable.</span></div>
              <div><DeviceMobile size={22} /><strong>One phone</strong><span>Placed flat in the fixture under the UVC camera.</span></div>
              <div><Cpu size={22} /><strong>One Mac</strong><span>macOS. The installer provisions Node.js, Python, and FFmpeg when needed.</span></div>
            </div>
            <div className={styles.note}><WarningCircle size={18} /><p><strong>Current platform limit:</strong> the local hardware runtime supports macOS. Windows and Linux are not supported yet.</p></div>
          </section>

          <section className={styles.section} id="connect">
            <div className={styles.sectionTitle}><DownloadSimple size={22} /><div><span>STEP 1</span><h2>Install and connect</h2></div></div>
            <Step number="1" title="Run the official macOS installer">
              <CodeBlock label="Terminal" value={installer} />
              <p>
                The installer verifies the published package, installs it under <code>{"~/.screenhand"}</code>,
                creates the <code>screenhand</code> command, and starts onboarding.
                The release package is SHA-256 verified before any files are installed.
              </p>
            </Step>
            <Step number="2" title="Connect the hardware"><p>Connect the 12 V power supply, the CH340 controller USB cable, and the UVC camera to the Mac. Connect only one new arm during first setup.</p></Step>
            <Step number="3" title="Continue or reopen onboarding"><CodeBlock label="Terminal" value="screenhand onboard" /><p>Onboarding installs the localhost background services and opens the Dashboard. When macOS asks, allow <strong>ScreenHand Camera</strong> to use the connected UVC camera. Onboarding never moves or homes the arm.</p></Step>
            <Step number="4" title="Open the local Dashboard"><p>Open <a href="http://127.0.0.1:3012">http://127.0.0.1:3012</a>. The Connections page should show one camera and one controller.</p></Step>
            <details className={styles.sourceInstall}><summary>Installing from source?</summary><CodeBlock label="Developer source install" value={sourceSetup} /></details>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><TerminalWindow size={22} /><div><span>VERIFY</span><h2>Check the local runtime</h2></div></div>
            <CodeBlock label="Terminal" value="screenhand doctor" />
            <div className={styles.expected}>
              <span>Expected</span>
              <code>✓ Dashboard</code><code>✓ Control API</code><code>✓ Black arm node</code><code>✓ UVC camera</code><code>✓ Controller</code>
            </div>
            <p>If a line is not green, do not try to move the arm. Use the troubleshooting table below.</p>
          </section>

          <section className={styles.section} id="calibrate">
            <div className={styles.sectionTitle}><Wrench size={22} /><div><span>STEP 2</span><h2>Home and calibrate</h2></div></div>
            <div className={styles.safetyBanner}><ShieldCheck size={24} weight="fill" /><div><strong>Human check required</strong><p>Remove hands, cables, and tools from the arm workspace before Home. Keep the physical power switch reachable.</p></div></div>
            <ol className={styles.checklist}>
              <li><span>1</span><div><strong>Open Connections</strong><p>Confirm camera and controller are connected.</p></div></li>
              <li><span>2</span><div><strong>Run Home</strong><p>Clear the workspace, select the device, and confirm Home in the Dashboard.</p></div></li>
              <li><span>3</span><div><strong>Place the phone</strong><p>Keep it flat, fully visible, and fixed. Do not move the phone or camera after calibration.</p></div></li>
              <li><span>4</span><div><strong>Open Calibrate</strong><p>Follow the four-corner guide. The resulting profile belongs only to this arm, phone placement, and camera frame size.</p></div></li>
              <li><span>5</span><div><strong>Check Tap capability</strong><p>Continue only when the API reports <code>capabilities.actions.tap.available: true</code>.</p></div></li>
            </ol>
          </section>

          <section className={styles.section} id="first-tap">
            <div className={styles.sectionTitle}><HandTap size={22} /><div><span>STEP 3</span><h2>Send the first physical tap</h2></div></div>
            <p>Use the Dashboard first: choose the device, click <strong>Enable control</strong>, then click a safe point on the live phone image.</p>
            <p>To verify the full API flow, run the included example. Replace the device ID and coordinates. The final <code>--execute</code> flag is required because this command moves real hardware.</p>
            <CodeBlock label="One real tap" value="npm run example:first-tap -- black-arm-01 360 780 --execute" />
            <p>The example gets a fresh frame, submits the tap with an idempotency key, and waits until the hardware receipt is <code>completed</code> or <code>failed</code>.</p>
          </section>

          <section className={styles.section} id="rest">
            <div className={styles.sectionTitle}><Code size={22} /><div><span>BUILD WITH REST</span><h2>Small API, complete control</h2></div></div>
            <p>Base URL: <code>{API_BASE}</code>. Always read live capabilities before sending an action.</p>
            <CodeBlock label="List devices and capabilities" value={listDevices} />
            <CodeBlock label="Submit a calibrated tap" value={tapRequest} />
            <div className={styles.flow}><div><span>1</span><strong>GET device</strong><small>Check capability</small></div><ArrowRight /><div><span>2</span><strong>GET screenshot</strong><small>Read frame headers</small></div><ArrowRight /><div><span>3</span><strong>POST action</strong><small>Use exact frame</small></div><ArrowRight /><div><span>4</span><strong>GET receipt</strong><small>Wait for final state</small></div></div>
            <p>A <code>202 Accepted</code> response means the arm accepted the job. It does not mean the physical movement finished.</p>
            <p>Mechanical <code>home</code> is available through REST with the exact <code>CLEAR_WORKSPACE_AND_HOME</code> confirmation. It is different from <code>phone_key: home</code>. A human must inspect the physical workspace immediately before mechanical Home.</p>
          </section>

          <section className={styles.section} id="agent">
            <div className={styles.sectionTitle}><Robot size={22} /><div><span>BUILD WITH MCP</span><h2>Connect your own Agent</h2></div></div>
            <p>Any Agent host that supports a local stdio MCP server can use ScreenHand. The server supports MCP protocol 2026-07-28 and compatible 2025 clients. The Agent receives the real screenshot plus the exact frame metadata required for safe coordinates.</p>
            <div className={styles.agentHandoff}><div><ClipboardText size={24} weight="fill" /><span><strong>Give your Agent the complete operating guide</strong><small>Copies the MCP configuration, all 15 tools, receipt rules, coordinate workflow, and physical safety contract.</small></span></div><div><button type="button" onClick={() => void copyAgentGuide()}>{agentGuideCopied ? <Check size={16} /> : <ClipboardText size={16} />}{agentGuideCopied ? "Copied for Agent" : "Copy for Agent"}</button><a href="/agent-guide.txt" target="_blank" rel="noreferrer">Open plain text</a></div></div>
            <Step number="1" title="Keep ScreenHand running"><p>The Dashboard and Control API must be healthy on the same Mac.</p></Step>
            <Step number="2" title="Add this MCP server"><CodeBlock label="MCP configuration" value={mcpConfig} /><p>The installed <code>screenhand</code> command resolves the application folder automatically. Restart your Agent host after adding it.</p></Step>
            <Step number="3" title="Give the Agent this operating rule"><CodeBlock label="Recommended instruction" value={agentPrompt} /></Step>
            <div className={styles.agentReady}><CheckCircle size={22} weight="fill" /><div><strong>Agent-ready behavior</strong><p>Tap, long press, swipe, text, phone-key, Hold, Resume, and Wait tools wait for the final durable hardware receipt. Home is disabled for Agents unless a local administrator explicitly sets <code>SCREENHAND_MCP_ALLOW_HOME=1</code>. Review the local audit trail with <code>screenhand audit</code>.</p></div></div>
          </section>

          <section className={styles.section} id="actions">
            <div className={styles.sectionTitle}><Play size={22} /><div><span>REFERENCE</span><h2>Available actions</h2></div></div>
            <div className={styles.tableWrap}><table><thead><tr><th>Action</th><th>Required input</th><th>Notes</th></tr></thead><tbody>
              <tr><td><code>status</code></td><td>deviceId</td><td>Read controller state.</td></tr>
              <tr><td><code>hold</code></td><td>deviceId</td><td>Stop or pause motion immediately.</td></tr>
              <tr><td><code>resume</code></td><td>deviceId</td><td>Only available from a safe Hold state.</td></tr>
              <tr><td><code>home</code></td><td>human clearance confirmation</td><td>MCP opt-in required.</td></tr>
              <tr><td><code>hover_move</code></td><td>point + frame + viewport</td><td>Moves above the screen without touching.</td></tr>
              <tr><td><code>touch_down</code></td><td>point + frame + sessionId</td><td>Starts a watchdog-protected live mouse contact.</td></tr>
              <tr><td><code>touch_move</code></td><td>point + frame + sessionId</td><td>Drags while the same physical contact remains down.</td></tr>
              <tr><td><code>touch_up</code></td><td>sessionId</td><td>Raises immediately; also safe to retry.</td></tr>
              <tr><td><code>touch_keepalive</code></td><td>sessionId</td><td>Refreshes the 1.5-second driver fail-safe.</td></tr>
              <tr><td><code>tap</code></td><td>point + frame + viewport</td><td>One calibrated physical touch.</td></tr>
              <tr><td><code>long_press</code></td><td>point + duration + frame</td><td>500–5000 ms.</td></tr>
              <tr><td><code>swipe</code></td><td>start + end + duration + frame</td><td>250–3000 ms.</td></tr>
              <tr><td><code>input_text</code></td><td>text</td><td>Requires a verified keyboard profile.</td></tr>
              <tr><td><code>phone_key</code></td><td>back, enter, or home</td><td>Camera-guided Back and only physically reachable Home strategies are exposed.</td></tr>
              <tr><td><code>wait</code></td><td>durationMs</td><td>Maximum 30000 ms per step.</td></tr>
            </tbody></table></div>
          </section>

          <section className={styles.section} id="safety">
            <div className={styles.sectionTitle}><ShieldCheck size={22} /><div><span>PHYSICAL SAFETY</span><h2>What the platform blocks</h2></div></div>
            <div className={styles.gates}>
              {["Unknown device or USB identity", "Missing or stale camera frame", "Controller not homed", "Missing or mismatched calibration", "Point outside the verified phone area", "Touch depth outside the verified range", "Controller in Hold or fault state"].map((item) => <div key={item}><CheckCircle size={17} weight="fill" /><span>{item}</span></div>)}
            </div>
            <div className={styles.note}><WarningCircle size={18} /><p>The local API binds to <code>127.0.0.1</code> by default. Do not expose port 3013 directly to the internet. Use the authenticated remote gateway for an approved remote deployment.</p></div>
          </section>

          <section className={styles.section} id="troubleshooting">
            <div className={styles.sectionTitle}><Wrench size={22} /><div><span>HELP</span><h2>Common problems</h2></div></div>
            <div className={styles.tableWrap}><table><thead><tr><th>Message</th><th>What it means</th><th>What to do</th></tr></thead><tbody>
              <tr><td>Device offline</td><td>The controller or camera was not identified.</td><td>Reconnect both USB cables, then run <code>screenhand doctor</code>.</td></tr>
              <tr><td>Homing required</td><td>This controller connection has no trusted origin.</td><td>Clear the workspace and run Home from the Dashboard.</td></tr>
              <tr><td>Calibration required</td><td>The current arm, camera, and phone placement are not verified together.</td><td>Open Calibrate and complete all four corners.</td></tr>
              <tr><td>Frame unavailable</td><td>The camera frame is missing or too old.</td><td>Check the UVC camera and request a new screenshot.</td></tr>
              <tr><td>UVC camera: no live video</td><td>macOS camera permission is missing or the camera is disconnected.</td><td>Enable <strong>ScreenHand Camera</strong> in System Settings → Privacy &amp; Security → Camera, then run <code>screenhand restart</code>.</td></tr>
              <tr><td>Target outside safe range</td><td>The coordinate maps outside the verified phone area.</td><td>Use a point inside the latest screenshot. Never clamp the coordinate.</td></tr>
              <tr><td>MCP tool not visible</td><td>The Agent host did not load the local server.</td><td>Run <code>screenhand status</code>, restart the host, and verify that <code>screenhand mcp</code> is available.</td></tr>
            </tbody></table></div>
          </section>

          <footer className={styles.footer}><div><Robot size={20} weight="fill" /><span><strong>ScreenHand Developer Platform</strong><small>Human control, REST API, WebSocket video, and MCP.</small></span></div><span><a href="/agent-guide.txt">Agent guide <ArrowRight size={14} /></a><a href="/openapi.json">OpenAPI 3.1.2 <ArrowRight size={14} /></a></span></footer>
        </article>
      </div>
    </main>
  );
}

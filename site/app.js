(() => {
  "use strict";

  const fallbackStatus = {
    schema_version: 1,
    generated_at: null,
    status: "unknown",
    status_message: "The first live status snapshot will appear after the next verified deployment.",
    last_scheduled_run_at: null,
    heartbeat: {
      state: "unknown",
      message: "The public page has not received a live schedule update yet."
    },
    recent_runs: [],
    checks: [
      { id: "automatic_runs", label: "Automatic runs", state: "unknown", message: "Waiting for a live snapshot." },
      { id: "failure_recovery", label: "Failure recovery", state: "unknown", message: "Waiting for the latest proof." },
      { id: "safety_limit", label: "Safety limit", state: "unknown", message: "Waiting for the latest proof." },
      { id: "monitoring", label: "Monitoring", state: "unknown", message: "Waiting for a live snapshot." }
    ],
    proof: {
      state: "unknown",
      verified_at: null,
      message: "The latest verified deployment will appear here.",
      url: "https://github.com/phatcobra/aws-operations-poc/actions"
    }
  };

  const simulationCopy = {
    simple: {
      normal: {
        title: "Normal run",
        explanation: "The system gets the data successfully on the first try.",
        steps: [
          ["✓", "Try 1", "Worked normally", "success"]
        ],
        result: "Result: Success — nothing needed fixing.",
        resultTone: "success"
      },
      transient: {
        title: "Temporary problem",
        explanation: "The first try fails, so the system waits briefly and tries again.",
        steps: [
          ["!", "Try 1", "Temporary problem detected", "warning"],
          ["↻", "Recovery", "Waiting briefly before trying again", ""],
          ["✓", "Try 2", "Worked — the system recovered", "success"]
        ],
        result: "Result: Recovered automatically after 1 failure.",
        resultTone: "success"
      },
      permanent: {
        title: "Persistent problem",
        explanation: "The problem continues. The system tries only three times and then stops instead of retrying forever.",
        steps: [
          ["!", "Try 1", "Failed", "warning"],
          ["↻", "Try 2", "Failed again", ""],
          ["!", "Try 3", "Still failed", "warning"],
          ["■", "Safety limit", "Stopped safely", "warning"]
        ],
        result: "Result: Safely stopped after 3 attempts.",
        resultTone: "warning"
      }
    },
    technical: {
      normal: {
        title: "Normal execution",
        explanation: "Lambda completes on attempt 1 and records recovery_state=not_needed.",
        steps: [
          ["✓", "Attempt 1", "status=success · recovery_state=not_needed", "success"]
        ],
        result: "Final state: success / attempt_number=1.",
        resultTone: "success"
      },
      transient: {
        title: "Transient failure + bounded recovery",
        explanation: "Attempt 1 fails deterministically. The retry loop backs off, then attempt 2 succeeds.",
        steps: [
          ["!", "Attempt 1", "status=failure · recovery_state=retrying", "warning"],
          ["↻", "Backoff", "bounded exponential delay", ""],
          ["✓", "Attempt 2", "status=success · recovery_state=recovered", "success"]
        ],
        result: "Final state: success / recovered / attempt_number=2.",
        resultTone: "success"
      },
      permanent: {
        title: "Permanent failure + exhaustion",
        explanation: "Every attempt fails. MAX_ATTEMPTS=3 prevents an unbounded retry loop.",
        steps: [
          ["!", "Attempt 1", "failure · retrying", "warning"],
          ["!", "Attempt 2", "failure · retrying", "warning"],
          ["!", "Attempt 3", "failure · exhausted", "warning"],
          ["■", "Policy", "no further attempts allowed", "warning"]
        ],
        result: "Final state: failure / exhausted / attempt_number=3.",
        resultTone: "warning"
      }
    }
  };

  const flowCopy = {
    simple: [
      ["Runs automatically", "Every hour, AWS starts the job without anyone pressing a button."],
      ["Gets live data", "The program asks a public weather service for current information."],
      ["Saves what happened", "Each attempt is recorded so there is a permanent history."],
      ["Notices problems", "The system detects when a request does not work."],
      ["Tries safely again", "Temporary problems get a limited number of automatic retries."],
      ["Shows the result", "The website and monitoring tools explain what happened."]
    ],
    technical: [
      ["EventBridge", "An hourly EventBridge rule invokes the Lambda function."],
      ["Lambda", "Python requests the Open-Meteo endpoint with a bounded timeout."],
      ["DynamoDB", "Each attempt is persisted under run_id and timestamp."],
      ["CloudWatch", "Structured logs and native Lambda metrics expose operational state."],
      ["Retry policy", "The application owns a bounded MAX_ATTEMPTS=3 recovery loop."],
      ["Proof", "GitHub Actions verifies live behavior after deployment."]
    ]
  };

  const dom = {
    statusBanner: document.getElementById("status-banner"),
    statusSymbol: document.getElementById("status-symbol"),
    statusTitle: document.getElementById("status-title"),
    statusMessage: document.getElementById("status-message"),
    lastCheckTime: document.getElementById("last-check-time"),
    lastCheckDetail: document.getElementById("last-check-detail"),
    sourceState: document.getElementById("source-state"),
    activityChip: document.getElementById("activity-chip"),
    activityList: document.getElementById("activity-list"),
    checkCount: document.getElementById("check-count"),
    checksList: document.getElementById("checks-list"),
    refreshButton: document.getElementById("refresh-button"),
    languageMode: document.getElementById("language-mode"),
    simulationOutput: document.getElementById("simulation-output"),
    flowGrid: document.getElementById("flow-grid"),
    flowDetail: document.getElementById("flow-detail"),
    proofMessage: document.getElementById("proof-message"),
    proofLink: document.getElementById("proof-link")
  };

  let selectedScenario = null;
  let simulationTimers = [];
  let currentStatus = fallbackStatus;

  function setText(element, value) {
    element.textContent = value == null || value === "" ? "Not available" : String(value);
  }

  function asDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = asDate(value);
    if (!date) return "Not available";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function relativeTime(value) {
    const date = asDate(value);
    if (!date) return "Not available";
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }

  function normalizeStatus(value) {
    if (!value || typeof value !== "object") return fallbackStatus;
    return {
      ...fallbackStatus,
      ...value,
      heartbeat: { ...fallbackStatus.heartbeat, ...(value.heartbeat || {}) },
      recent_runs: Array.isArray(value.recent_runs) ? value.recent_runs : [],
      checks: Array.isArray(value.checks) ? value.checks : fallbackStatus.checks,
      proof: { ...fallbackStatus.proof, ...(value.proof || {}) }
    };
  }

  function statusPresentation(status) {
    if (status === "healthy") {
      return { className: "status-healthy", symbol: "✓", title: "Everything is working normally" };
    }
    if (status === "degraded") {
      return { className: "status-degraded", symbol: "!", title: "Something needs attention" };
    }
    return { className: "status-unknown", symbol: "?", title: "Live status is not available" };
  }

  function resultPresentation(result) {
    if (result === "success") return { label: "Worked normally", icon: "✓", className: "success" };
    if (result === "recovered") return { label: "Failed once, then recovered", icon: "↻", className: "recovered" };
    if (result === "exhausted") return { label: "Stopped safely after 3 tries", icon: "!", className: "exhausted" };
    return { label: "Needs attention", icon: "?", className: "recovered" };
  }

  function checkPresentation(state) {
    if (state === "pass") return { label: "Working", className: "pass" };
    if (state === "fail") return { label: "Attention", className: "fail" };
    return { label: "Unknown", className: "unknown" };
  }

  function renderStatus(data) {
    currentStatus = normalizeStatus(data);
    const presentation = statusPresentation(currentStatus.status);
    dom.statusBanner.className = `status-banner ${presentation.className}`;
    setText(dom.statusSymbol, presentation.symbol);
    setText(dom.statusTitle, presentation.title);
    setText(dom.statusMessage, currentStatus.status_message);

    const lastRun = currentStatus.last_scheduled_run_at;
    setText(dom.lastCheckTime, lastRun ? relativeTime(lastRun) : "Waiting for live data");
    setText(dom.lastCheckDetail, lastRun ? `Last seen ${formatDate(lastRun)}` : "No automatic check has been published yet.");
    setText(dom.sourceState, currentStatus.generated_at ? `Updated ${relativeTime(currentStatus.generated_at)}` : "Waiting");
    dom.activityChip.textContent = currentStatus.recent_runs.length ? `${currentStatus.recent_runs.length} updates` : "No live data";
    renderActivity(currentStatus.recent_runs);
    renderChecks(currentStatus.checks);
    renderProof(currentStatus.proof);
  }

  function renderActivity(runs) {
    dom.activityList.replaceChildren();
    if (!runs.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "No live run history yet";
      const detail = document.createElement("span");
      detail.textContent = "The safe simulation below is ready to use while the next snapshot is published.";
      empty.append(title, detail);
      dom.activityList.appendChild(empty);
      return;
    }

    runs.slice(0, 8).forEach((run) => {
      const presentation = resultPresentation(run.result);
      const row = document.createElement("div");
      row.className = "activity-item";

      const icon = document.createElement("span");
      icon.className = `activity-icon ${presentation.className}`;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = presentation.icon;

      const content = document.createElement("div");
      const title = document.createElement("p");
      title.className = "activity-title";
      title.textContent = presentation.label;
      const meta = document.createElement("p");
      meta.className = "activity-meta";
      const trigger = run.trigger === "automatic" ? "Automatic check" : run.trigger === "verification" ? "Verified test" : "Manual check";
      meta.textContent = `${trigger} · ${run.attempts || 1} ${run.attempts === 1 ? "attempt" : "attempts"}`;
      content.append(title, meta);

      const time = document.createElement("time");
      time.className = "activity-time";
      time.dateTime = run.at || "";
      time.textContent = relativeTime(run.at);
      row.append(icon, content, time);
      dom.activityList.appendChild(row);
    });
  }

  function renderChecks(checks) {
    dom.checksList.replaceChildren();
    const list = checks.length ? checks : fallbackStatus.checks;
    const passing = list.filter((check) => check.state === "pass").length;
    dom.checkCount.textContent = `${passing}/${list.length} working`;
    list.forEach((check) => {
      const presentation = checkPresentation(check.state);
      const row = document.createElement("div");
      row.className = "check-row";
      const textWrap = document.createElement("div");
      const label = document.createElement("div");
      label.className = "check-label";
      label.textContent = check.label || "System check";
      const description = document.createElement("p");
      description.className = "check-description";
      description.textContent = check.message || "No explanation available.";
      textWrap.append(label, description);
      const state = document.createElement("span");
      state.className = `check-status ${presentation.className}`;
      state.textContent = presentation.label;
      row.append(textWrap, state);
      dom.checksList.appendChild(row);
    });
  }

  function isSafeGithubUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname.endsWith(".github.com"));
    } catch {
      return false;
    }
  }

  function renderProof(proof) {
    if (proof && proof.state === "verified" && proof.verified_at) {
      setText(dom.proofMessage, `A live deployment test passed ${formatDate(proof.verified_at)}. It checked normal work, automatic recovery, and safe shutdown.`);
    } else {
      setText(dom.proofMessage, proof?.message || fallbackStatus.proof.message);
    }
    const url = proof && isSafeGithubUrl(proof.url) ? proof.url : fallbackStatus.proof.url;
    dom.proofLink.href = url;
  }

  function renderFlow(selected = 0) {
    const mode = dom.languageMode.value;
    const steps = flowCopy[mode] || flowCopy.simple;
    dom.flowGrid.replaceChildren();
    steps.forEach((step, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "flow-step";
      button.setAttribute("aria-selected", String(index === selected));
      button.setAttribute("aria-label", `Step ${index + 1}: ${step[0]}`);
      const number = document.createElement("span");
      number.className = "flow-number";
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "flow-label";
      label.textContent = step[0];
      button.append(number, label);
      button.addEventListener("click", () => renderFlow(index));
      dom.flowGrid.appendChild(button);
    });
    const selectedStep = steps[selected] || steps[0];
    dom.flowDetail.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = `${selected + 1}. ${selectedStep[0]}`;
    const copy = document.createElement("p");
    copy.textContent = selectedStep[1];
    dom.flowDetail.append(title, copy);
  }

  function clearSimulationTimers() {
    simulationTimers.forEach((timer) => window.clearTimeout(timer));
    simulationTimers = [];
  }

  function runSimulation(name) {
    clearSimulationTimers();
    selectedScenario = name;
    document.querySelectorAll(".scenario-button").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.scenario === name));
    });

    const mode = dom.languageMode.value;
    const data = simulationCopy[mode][name];
    dom.simulationOutput.replaceChildren();
    const title = document.createElement("h3");
    title.className = "simulation-title";
    title.textContent = data.title;
    const explanation = document.createElement("p");
    explanation.className = "simulation-explanation";
    explanation.textContent = data.explanation;
    const attemptList = document.createElement("div");
    attemptList.className = "attempt-list";
    const result = document.createElement("p");
    result.className = `simulation-result ${data.resultTone === "warning" ? "warning" : ""}`;
    result.textContent = data.result;
    result.hidden = true;
    dom.simulationOutput.append(title, explanation, attemptList, result);

    data.steps.forEach((step, index) => {
      const timer = window.setTimeout(() => {
        const row = document.createElement("div");
        row.className = `attempt-row ${step[3] || ""}`;
        const icon = document.createElement("span");
        icon.className = "attempt-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = step[0];
        const copy = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = step[1];
        const detail = document.createElement("span");
        detail.textContent = step[2];
        copy.append(label, detail);
        row.append(icon, copy);
        attemptList.appendChild(row);
      }, index * 430);
      simulationTimers.push(timer);
    });

    simulationTimers.push(window.setTimeout(() => {
      result.hidden = false;
    }, data.steps.length * 430 + 100));
  }

  async function loadStatus() {
    dom.refreshButton.disabled = true;
    dom.refreshButton.classList.add("is-refreshing");
    dom.refreshButton.querySelector(".refresh-icon").textContent = "…";
    try {
      const response = await fetch(`./status.json?refresh=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status request failed: ${response.status}`);
      renderStatus(await response.json());
    } catch {
      renderStatus(fallbackStatus);
      dom.sourceState.textContent = "Unavailable";
    } finally {
      dom.refreshButton.disabled = false;
      dom.refreshButton.classList.remove("is-refreshing");
      dom.refreshButton.querySelector(".refresh-icon").textContent = "↻";
    }
  }

  document.querySelectorAll(".scenario-button").forEach((button) => {
    button.addEventListener("click", () => runSimulation(button.dataset.scenario));
  });

  dom.languageMode.addEventListener("change", () => {
    renderFlow(0);
    if (selectedScenario) runSimulation(selectedScenario);
  });

  dom.refreshButton.addEventListener("click", loadStatus);
  renderFlow(0);
  loadStatus();
})();

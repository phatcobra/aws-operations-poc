(() => {
  "use strict";

  const fallbackStatus = {
    schema_version: 1,
    generated_at: null,
    status: "unknown",
    status_message: "The public snapshot is not available yet.",
    last_scheduled_run_at: null,
    heartbeat: {
      state: "unknown",
      message: "No schedule signal has been published yet."
    },
    recent_runs: [],
    checks: [
      { id: "automatic_runs", label: "Automatic runs", state: "unknown", message: "Waiting for a live snapshot." },
      { id: "failure_recovery", label: "Failure recovery", state: "unknown", message: "No recovery proof is attached to this snapshot." },
      { id: "safety_limit", label: "Safety limit", state: "unknown", message: "No safety-limit proof is attached to this snapshot." },
      { id: "monitoring", label: "Monitoring", state: "unknown", message: "Waiting for a live snapshot." }
    ],
    proof: {
      state: "unknown",
      verified_at: null,
      message: "The latest verified deployment will appear here.",
      url: "https://github.com/phatcobra/aws-operations-poc/actions"
    }
  };

  const walkthrough = [
    {
      target: "health",
      label: "Health",
      title: "1. Start with the health signal",
      copy: "This is the first question: can the public snapshot confirm that the scheduled workload is healthy? Healthy means a recent schedule signal and a normal latest scheduled result."
    },
    {
      target: "signals",
      label: "Signals",
      title: "2. Check the heartbeat and guards",
      copy: "Heartbeat tells you whether the schedule is arriving. Recovery and safety-limit checks tell you whether the failure policy behaves as designed."
    },
    {
      target: "runs",
      label: "Runs",
      title: "3. Read the recent execution history",
      copy: "The table groups attempts into one row per invocation. Attempts expose recovery behavior; latency is the final attempt's duration; the timeline makes the latest outcomes easy to narrate."
    },
    {
      target: "proof",
      label: "Proof",
      title: "4. Separate current health from deployment proof",
      copy: "The proof card answers a different question: did the latest verified deployment exercise normal work, recovery, and safe exhaustion?"
    },
    {
      target: "boundary",
      label: "Boundary",
      title: "5. State the boundary clearly",
      copy: "This page is a sanitized, read-only view. It explains the signals without exposing raw logs or giving visitors any way to invoke AWS or change resources."
    }
  ];

  const dom = {
    explainToggle: document.getElementById("explain-toggle"),
    explainPanel: document.getElementById("explain-panel"),
    explainTitle: document.getElementById("explain-title"),
    explainCopy: document.getElementById("explain-copy"),
    stepCount: document.getElementById("step-count"),
    stepNav: document.getElementById("step-nav"),
    previousStep: document.getElementById("previous-step"),
    nextStep: document.getElementById("next-step"),
    refreshButton: document.getElementById("refresh-button"),
    snapshotRelative: document.getElementById("snapshot-relative"),
    snapshotAbsolute: document.getElementById("snapshot-absolute"),
    sourceState: document.getElementById("source-state"),
    overallBadge: document.getElementById("overall-badge"),
    statusSymbol: document.getElementById("status-symbol"),
    statusTitle: document.getElementById("status-title"),
    statusMessage: document.getElementById("status-message"),
    lastRunRelative: document.getElementById("last-run-relative"),
    lastRunAbsolute: document.getElementById("last-run-absolute"),
    latestLatency: document.getElementById("latest-latency"),
    recentRunCount: document.getElementById("recent-run-count"),
    signalGrid: document.getElementById("signal-grid"),
    successCount: document.getElementById("success-count"),
    recoveredCount: document.getElementById("recovered-count"),
    exhaustedCount: document.getElementById("exhausted-count"),
    problemCount: document.getElementById("problem-count"),
    runsBody: document.getElementById("runs-body"),
    timeline: document.getElementById("timeline"),
    proofBadge: document.getElementById("proof-badge"),
    proofMessage: document.getElementById("proof-message"),
    proofScenarios: document.getElementById("proof-scenarios"),
    proofLink: document.getElementById("proof-link")
  };

  let currentStatus = fallbackStatus;
  let explanationStep = 0;

  function setText(element, value, fallback = "Not available") {
    element.textContent = value == null || value === "" ? fallback : String(value);
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
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function relativeTime(value) {
    const date = asDate(value);
    if (!date) return "Not available";
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 0 || seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }

  function formatLatency(value) {
    const latency = Number(value);
    if (!Number.isFinite(latency)) return "—";
    return `${latency >= 100 ? Math.round(latency) : latency.toFixed(1)} ms`;
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

  function overallPresentation(status) {
    if (status === "healthy") return { label: "HEALTHY", title: "Healthy", className: "healthy", symbol: "✓" };
    if (status === "degraded") return { label: "DEGRADED", title: "Needs attention", className: "degraded", symbol: "!" };
    return { label: "UNKNOWN", title: "Status unavailable", className: "unknown", symbol: "?" };
  }

  function signalPresentation(key, state) {
    if (key === "heartbeat") {
      if (state === "ok") return { label: "OK", className: "ok" };
      if (state === "stale") return { label: "ALARM", className: "alarm" };
      return { label: "UNKNOWN", className: "unknown" };
    }
    if (state === "pass") return { label: "WORKING", className: "ok" };
    if (state === "fail") return { label: "ATTENTION", className: "alarm" };
    return { label: "UNKNOWN", className: "unknown" };
  }

  function resultPresentation(result) {
    if (result === "success") return { label: "SUCCESS", className: "success", marker: "✓" };
    if (result === "recovered") return { label: "RECOVERED", className: "recovered", marker: "↻" };
    if (result === "exhausted") return { label: "EXHAUSTED", className: "exhausted", marker: "!" };
    return { label: "PROBLEM", className: "problem", marker: "?" };
  }

  function triggerLabel(trigger) {
    if (trigger === "automatic") return "Scheduled";
    if (trigger === "verification") return "Live proof";
    return "Manual";
  }

  function checkById(id) {
    return currentStatus.checks.find((check) => check.id === id) || {
      id,
      label: id.replaceAll("_", " "),
      state: "unknown",
      message: "No signal has been published."
    };
  }

  function applyStateClass(element, prefix, state) {
    element.className = `${prefix} ${prefix}-${state}`;
  }

  function renderStatus(data) {
    currentStatus = normalizeStatus(data);
    const overall = overallPresentation(currentStatus.status);
    applyStateClass(dom.overallBadge, "state-badge", overall.className);
    setText(dom.overallBadge, overall.label);
    applyStateClass(dom.statusSymbol, "health-symbol", overall.className);
    setText(dom.statusSymbol, overall.symbol);
    setText(dom.statusTitle, overall.title);
    setText(dom.statusMessage, currentStatus.status_message);

    setText(dom.snapshotRelative, currentStatus.generated_at ? relativeTime(currentStatus.generated_at) : "Not published");
    setText(dom.snapshotAbsolute, currentStatus.generated_at ? formatDate(currentStatus.generated_at) : "Waiting for the published snapshot.");
    setText(dom.sourceState, currentStatus.generated_at ? "Live snapshot loaded" : "No live snapshot");

    const scheduledRun = currentStatus.last_scheduled_run_at;
    const latestRun = currentStatus.recent_runs[0] || null;
    setText(dom.lastRunRelative, scheduledRun ? relativeTime(scheduledRun) : "Not available");
    setText(dom.lastRunAbsolute, scheduledRun ? formatDate(scheduledRun) : "No automatic run published yet.");
    setText(dom.latestLatency, latestRun ? formatLatency(latestRun.latency_ms) : "—");
    setText(dom.recentRunCount, currentStatus.recent_runs.length, "0");

    renderSignals();
    renderRuns();
    renderProof();
  }

  function renderSignals() {
    const recovery = checkById("failure_recovery");
    const safety = checkById("safety_limit");
    const monitoring = checkById("monitoring");
    const signals = [
      {
        key: "heartbeat",
        label: "Heartbeat / alarm",
        state: currentStatus.heartbeat.state,
        message: currentStatus.heartbeat.message,
        context: "Schedule freshness signal · alarm meaning: late or missing check"
      },
      {
        key: "failure_recovery",
        label: recovery.label || "Failure recovery",
        state: recovery.state,
        message: recovery.message,
        context: "Expected behavior · temporary failure can recover"
      },
      {
        key: "safety_limit",
        label: safety.label || "Safety limit",
        state: safety.state,
        message: safety.message,
        context: "Expected behavior · retry loop stops at attempt 3"
      },
      {
        key: "monitoring",
        label: monitoring.label || "Monitoring",
        state: monitoring.state,
        message: monitoring.message,
        context: "Signal source · recent structured activity"
      }
    ];

    dom.signalGrid.replaceChildren();
    signals.forEach((signal) => {
      const presentation = signalPresentation(signal.key, signal.state);
      const card = document.createElement("article");
      card.className = `signal-card signal-${presentation.className}`;

      const header = document.createElement("div");
      header.className = "signal-header";
      const label = document.createElement("h3");
      label.className = "signal-label";
      label.textContent = signal.label;
      const badge = document.createElement("span");
      badge.className = `state-badge state-${presentation.className}`;
      badge.textContent = presentation.label;
      header.append(label, badge);

      const message = document.createElement("p");
      message.className = "signal-message";
      message.textContent = signal.message || "No explanation is available for this signal.";

      const context = document.createElement("p");
      context.className = "signal-context";
      context.textContent = signal.context;

      card.append(header, message, context);
      dom.signalGrid.appendChild(card);
    });
  }

  function createTableCell(content, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    return cell;
  }

  function renderRuns() {
    const runs = currentStatus.recent_runs;
    const counts = { success: 0, recovered: 0, exhausted: 0, problem: 0 };
    runs.forEach((run) => {
      const key = Object.prototype.hasOwnProperty.call(counts, run.result) ? run.result : "problem";
      counts[key] += 1;
    });
    setText(dom.successCount, counts.success, "0");
    setText(dom.recoveredCount, counts.recovered, "0");
    setText(dom.exhaustedCount, counts.exhausted, "0");
    setText(dom.problemCount, counts.problem, "0");

    dom.runsBody.replaceChildren();
    if (!runs.length) {
      const row = document.createElement("tr");
      row.appendChild(createTableCell("No sanitized runs in this snapshot.", "table-empty"));
      row.firstChild.colSpan = 5;
      dom.runsBody.appendChild(row);
    } else {
      runs.slice(0, 8).forEach((run, index) => {
        const row = document.createElement("tr");
        if (index === 0) row.className = "latest-run";

        const timeStack = document.createElement("div");
        timeStack.className = "time-stack";
        const time = document.createElement("time");
        time.dateTime = run.at || "";
        time.textContent = relativeTime(run.at);
        const exact = document.createElement("span");
        exact.textContent = formatDate(run.at);
        timeStack.append(time, exact);
        if (index === 0) {
          const latest = document.createElement("span");
          latest.className = "latest-label";
          latest.textContent = "Latest";
          timeStack.appendChild(latest);
        }

        const trigger = document.createElement("span");
        trigger.className = "trigger-label";
        trigger.textContent = triggerLabel(run.trigger);

        const result = resultPresentation(run.result);
        const outcome = document.createElement("span");
        outcome.className = `state-badge state-${result.className}`;
        outcome.textContent = result.label;

        const attempts = document.createElement("span");
        attempts.className = "mono-value";
        attempts.textContent = `${run.attempts || 1}`;

        const latency = document.createElement("span");
        latency.className = "mono-value";
        latency.textContent = formatLatency(run.latency_ms);

        row.append(
          createTableCell(timeStack),
          createTableCell(trigger),
          createTableCell(outcome),
          createTableCell(attempts, "numeric-cell"),
          createTableCell(latency, "numeric-cell")
        );
        dom.runsBody.appendChild(row);
      });
    }

    renderTimeline(runs);
  }

  function renderTimeline(runs) {
    dom.timeline.replaceChildren();
    if (!runs.length) {
      const empty = document.createElement("li");
      empty.className = "timeline-empty";
      empty.textContent = "No run history in this snapshot.";
      dom.timeline.appendChild(empty);
      return;
    }

    runs.slice(0, 6).forEach((run) => {
      const result = resultPresentation(run.result);
      const item = document.createElement("li");
      item.className = "timeline-item";
      const marker = document.createElement("span");
      marker.className = `timeline-marker ${result.className}`;
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = result.marker;
      const content = document.createElement("div");
      const title = document.createElement("div");
      title.className = "timeline-title";
      const outcome = document.createElement("strong");
      outcome.textContent = result.label;
      const trigger = document.createElement("span");
      trigger.textContent = triggerLabel(run.trigger);
      title.append(outcome, trigger);
      const detail = document.createElement("p");
      detail.textContent = `${relativeTime(run.at)} · ${run.attempts || 1} ${(run.attempts || 1) === 1 ? "attempt" : "attempts"} · ${formatLatency(run.latency_ms)}`;
      content.append(title, detail);
      item.append(marker, content);
      dom.timeline.appendChild(item);
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

  function renderProof() {
    const proof = currentStatus.proof || fallbackStatus.proof;
    const verified = proof.state === "verified";
    applyStateClass(dom.proofBadge, "state-badge", verified ? "verified" : "unknown");
    setText(dom.proofBadge, verified ? "VERIFIED" : "UNKNOWN");
    setText(dom.proofMessage, proof.message || fallbackStatus.proof.message);
    dom.proofLink.href = isSafeGithubUrl(proof.url) ? proof.url : fallbackStatus.proof.url;

    dom.proofScenarios.replaceChildren();
    const scenarioLabels = {
      normal: "Normal",
      transient: "Recovery",
      permanent: "Safety limit"
    };
    const scenarios = proof.scenarios && typeof proof.scenarios === "object" ? proof.scenarios : {};
    const keys = Object.keys(scenarios).filter((key) => Object.prototype.hasOwnProperty.call(scenarioLabels, key));
    if (!keys.length) {
      const empty = document.createElement("p");
      empty.className = "proof-empty";
      empty.textContent = "No live-proof scenario summary is attached to this snapshot.";
      dom.proofScenarios.appendChild(empty);
      return;
    }

    keys.forEach((key) => {
      const data = scenarios[key] || {};
      const result = resultPresentation(data.result);
      const item = document.createElement("div");
      item.className = "proof-scenario";
      const label = document.createElement("span");
      label.textContent = scenarioLabels[key];
      const outcome = document.createElement("strong");
      outcome.className = `proof-result ${result.className}`;
      outcome.textContent = `${result.label} · ${data.attempts || "—"}`;
      item.append(label, outcome);
      dom.proofScenarios.appendChild(item);
    });
  }

  function renderStepNav() {
    dom.stepNav.replaceChildren();
    walkthrough.forEach((step, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "step-button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(index === explanationStep));
      button.setAttribute("aria-controls", `${step.target}-section`);
      button.textContent = `${index + 1} ${step.label}`;
      button.addEventListener("click", () => setExplanationStep(index, true));
      dom.stepNav.appendChild(button);
    });
  }

  function setExplanationStep(index, shouldScroll) {
    explanationStep = Math.max(0, Math.min(index, walkthrough.length - 1));
    const step = walkthrough[explanationStep];
    setText(dom.stepCount, `${explanationStep + 1} / ${walkthrough.length}`);
    setText(dom.explainTitle, step.title);
    setText(dom.explainCopy, step.copy);
    dom.previousStep.disabled = explanationStep === 0;
    dom.nextStep.disabled = explanationStep === walkthrough.length - 1;
    dom.stepNav.querySelectorAll(".step-button").forEach((button, indexInNav) => {
      button.setAttribute("aria-selected", String(indexInNav === explanationStep));
    });
    document.querySelectorAll("[data-walkthrough-target]").forEach((section) => {
      section.classList.toggle("is-explained", section.dataset.walkthroughTarget === step.target);
    });
    if (shouldScroll) {
      document.getElementById(`${step.target}-section`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function setExplainMode(enabled) {
    dom.explainPanel.hidden = !enabled;
    dom.explainToggle.setAttribute("aria-pressed", String(enabled));
    document.body.classList.toggle("explain-mode", enabled);
    if (enabled) setExplanationStep(explanationStep, false);
    else document.querySelectorAll("[data-walkthrough-target]").forEach((section) => section.classList.remove("is-explained"));
  }

  async function loadStatus() {
    dom.refreshButton.disabled = true;
    dom.refreshButton.classList.add("is-loading");
    dom.sourceState.textContent = "Refreshing…";
    try {
      const response = await fetch(`./status.json?refresh=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status request failed: ${response.status}`);
      renderStatus(await response.json());
    } catch {
      renderStatus(fallbackStatus);
      dom.sourceState.textContent = "Snapshot unavailable";
    } finally {
      dom.refreshButton.disabled = false;
      dom.refreshButton.classList.remove("is-loading");
    }
  }

  dom.explainToggle.addEventListener("click", () => setExplainMode(dom.explainPanel.hidden));
  dom.previousStep.addEventListener("click", () => setExplanationStep(explanationStep - 1, true));
  dom.nextStep.addEventListener("click", () => setExplanationStep(explanationStep + 1, true));
  dom.refreshButton.addEventListener("click", loadStatus);

  renderStepNav();
  setExplanationStep(0, false);
  loadStatus();
})();

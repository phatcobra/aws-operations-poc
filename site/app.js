(() => {
  "use strict";

  const fallbackStatus = {
    schema_version: 1,
    generated_at: null,
    status: "unknown",
    status_message: "The helper's latest check is not available yet.",
    last_scheduled_run_at: null,
    heartbeat: {
      state: "unknown",
      message: "No schedule update has been published yet."
    },
    recent_runs: [],
    checks: [],
    proof: {
      state: "unknown",
      verified_at: null,
      message: "The latest live test will appear here.",
      url: "https://github.com/phatcobra/aws-operations-poc/actions"
    }
  };

  const story = [
    {
      icon: "◷",
      title: "The helper wakes up",
      description: "Every hour, a clock tells it to start on its own.",
      say: "“Nobody has to press a button. It starts on a schedule.”"
    },
    {
      icon: "☁",
      title: "It asks for the latest weather",
      description: "It asks a public weather service for one current reading.",
      say: "“Its job is simple: ask for the latest answer.”"
    },
    {
      icon: "▤",
      title: "It writes down what happened",
      description: "It records whether it got an answer, how many tries it needed, and how long it took.",
      say: "“There is a record of every check, not just a guess that it worked.”"
    },
    {
      icon: "↻",
      title: "It can try again",
      description: "If the first request has a temporary problem, it waits briefly and tries again.",
      say: "“A small hiccup does not immediately make the whole check fail.”"
    },
    {
      icon: "⏹",
      title: "It stops safely",
      description: "After three failed tries, it stops and records the problem instead of trying forever.",
      say: "“It is allowed to recover, but it has a clear stopping point.”"
    },
    {
      icon: "⌁",
      title: "You can see the result",
      description: "This page shows the latest check and a short history without giving anyone control of the real system.",
      say: "“The page is a window into what happened, not a remote control.”"
    }
  ];

  const dom = {
    refreshButton: document.getElementById("refresh-button"),
    overallBadge: document.getElementById("overall-badge"),
    statusSymbol: document.getElementById("status-symbol"),
    currentHeading: document.getElementById("current-heading"),
    statusMessage: document.getElementById("status-message"),
    lastRunRelative: document.getElementById("last-run-relative"),
    lastRunAbsolute: document.getElementById("last-run-absolute"),
    snapshotRelative: document.getElementById("snapshot-relative"),
    snapshotAbsolute: document.getElementById("snapshot-absolute"),
    recentList: document.getElementById("recent-list"),
    proofBadge: document.getElementById("proof-badge"),
    proofMessage: document.getElementById("proof-message"),
    proofList: document.getElementById("proof-list"),
    proofLink: document.getElementById("proof-link"),
    storyIcon: document.getElementById("story-icon"),
    storyStep: document.getElementById("story-step"),
    storyTitle: document.getElementById("story-title"),
    storyDescription: document.getElementById("story-description"),
    storySay: document.getElementById("story-say"),
    storyProgress: document.getElementById("story-progress"),
    storyNav: document.getElementById("story-nav"),
    stepCount: document.getElementById("step-count"),
    previousStep: document.getElementById("previous-step"),
    nextStep: document.getElementById("next-step")
  };

  let currentStatus = fallbackStatus;
  let storyStep = 0;

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

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds)) return "Time not available";
    if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} seconds`;
    return `${milliseconds >= 100 ? Math.round(milliseconds) : milliseconds.toFixed(1)} milliseconds`;
  }

  function normalizeStatus(value) {
    if (!value || typeof value !== "object") return fallbackStatus;
    return {
      ...fallbackStatus,
      ...value,
      heartbeat: { ...fallbackStatus.heartbeat, ...(value.heartbeat || {}) },
      recent_runs: Array.isArray(value.recent_runs) ? value.recent_runs : [],
      checks: Array.isArray(value.checks) ? value.checks : [],
      proof: { ...fallbackStatus.proof, ...(value.proof || {}) }
    };
  }

  function overallPresentation(status) {
    if (status === "healthy") {
      return { label: "WORKING", title: "The helper is working normally", className: "healthy", symbol: "✓" };
    }
    if (status === "degraded") {
      return { label: "NEEDS ATTENTION", title: "The helper needs attention", className: "degraded", symbol: "!" };
    }
    return { label: "UNKNOWN", title: "We do not know yet", className: "unknown", symbol: "?" };
  }

  function resultPresentation(result, attempts) {
    if (result === "success") {
      return {
        label: "Worked normally",
        detail: "Got an answer on the first try",
        className: "success",
        marker: "✓"
      };
    }
    if (result === "recovered") {
      return {
        label: "Had a hiccup, then worked",
        detail: `Needed ${attempts || 2} tries, then got an answer`,
        className: "recovered",
        marker: "↻"
      };
    }
    if (result === "exhausted") {
      return {
        label: "Stopped after three tries",
        detail: "Could not get an answer, so it stopped safely",
        className: "exhausted",
        marker: "!"
      };
    }
    return {
      label: "Could not finish",
      detail: "The helper recorded a problem",
      className: "problem",
      marker: "?"
    };
  }

  function triggerLabel(trigger) {
    if (trigger === "automatic") return "The hourly check";
    if (trigger === "verification") return "A project test";
    return "A manual check";
  }

  function applyStateClass(element, prefix, state) {
    element.className = `${prefix} ${prefix}-${state}`;
  }

  function renderStatus(data) {
    currentStatus = normalizeStatus(data);
    const overall = overallPresentation(currentStatus.status);
    applyStateClass(dom.overallBadge, "state-badge", overall.className);
    setText(dom.overallBadge, overall.label);
    applyStateClass(dom.statusSymbol, "current-symbol", overall.className);
    setText(dom.statusSymbol, overall.symbol);
    setText(dom.currentHeading, overall.title);
    setText(dom.statusMessage, currentStatus.status_message);

    const lastRun = currentStatus.last_scheduled_run_at;
    setText(dom.lastRunRelative, lastRun ? relativeTime(lastRun) : "Not available");
    setText(dom.lastRunAbsolute, lastRun ? formatDate(lastRun) : "No automatic check published yet.");
    setText(dom.snapshotRelative, currentStatus.generated_at ? relativeTime(currentStatus.generated_at) : "Not published");
    setText(dom.snapshotAbsolute, currentStatus.generated_at ? formatDate(currentStatus.generated_at) : "Waiting for the published snapshot.");

    renderRecentRuns(currentStatus.recent_runs);
    renderProof(currentStatus.proof);
  }

  function renderRecentRuns(runs) {
    dom.recentList.replaceChildren();
    if (!runs.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<strong>No checks have been published yet.</strong><span>The helper's history will appear here after its next update.</span>";
      dom.recentList.appendChild(empty);
      return;
    }

    runs.slice(0, 8).forEach((run, index) => {
      const presentation = resultPresentation(run.result, run.attempts);
      const item = document.createElement("article");
      item.className = `recent-item ${presentation.className}`;

      const marker = document.createElement("span");
      marker.className = "recent-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = presentation.marker;

      const content = document.createElement("div");
      content.className = "recent-content";
      const title = document.createElement("h3");
      title.textContent = presentation.label;
      const detail = document.createElement("p");
      detail.textContent = `${triggerLabel(run.trigger)} · ${presentation.detail}`;
      const duration = document.createElement("p");
      duration.className = "recent-duration";
      duration.textContent = formatDuration(run.latency_ms);
      content.append(title, detail, duration);

      const time = document.createElement("div");
      time.className = "recent-time";
      const relative = document.createElement("time");
      relative.dateTime = run.at || "";
      relative.textContent = relativeTime(run.at);
      const absolute = document.createElement("span");
      absolute.textContent = formatDate(run.at);
      time.append(relative, absolute);
      if (index === 0) {
        const latest = document.createElement("span");
        latest.className = "latest-tag";
        latest.textContent = "Latest";
        time.appendChild(latest);
      }

      item.append(marker, content, time);
      dom.recentList.appendChild(item);
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
    const safeProof = proof || fallbackStatus.proof;
    const verified = safeProof.state === "verified";
    applyStateClass(dom.proofBadge, "state-badge", verified ? "verified" : "unknown");
    setText(dom.proofBadge, verified ? "TEST PASSED" : "WAITING");
    setText(dom.proofMessage, safeProof.message || fallbackStatus.proof.message);
    dom.proofLink.href = isSafeGithubUrl(safeProof.url) ? safeProof.url : fallbackStatus.proof.url;
    dom.proofList.replaceChildren();

    const labels = {
      normal: ["Normal check", "Should work the first time"],
      transient: ["Temporary problem", "Should recover on try 2"],
      permanent: ["Problem that does not clear", "Should stop on try 3"]
    };
    const scenarios = safeProof.scenarios && typeof safeProof.scenarios === "object" ? safeProof.scenarios : {};
    const keys = Object.keys(scenarios).filter((key) => Object.prototype.hasOwnProperty.call(labels, key));
    if (!keys.length) {
      const empty = document.createElement("p");
      empty.className = "proof-empty";
      empty.textContent = "No live test summary is attached to this update yet.";
      dom.proofList.appendChild(empty);
      return;
    }

    keys.forEach((key) => {
      const result = resultPresentation(scenarios[key].result, scenarios[key].attempts);
      const item = document.createElement("div");
      item.className = "proof-item";
      const icon = document.createElement("span");
      icon.className = `proof-item-icon ${result.className}`;
      icon.textContent = result.marker;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = labels[key][0];
      const description = document.createElement("span");
      description.textContent = labels[key][1];
      copy.append(title, description);
      const outcome = document.createElement("b");
      outcome.className = result.className;
      outcome.textContent = `${result.label} · ${scenarios[key].attempts || "—"}`;
      item.append(icon, copy, outcome);
      dom.proofList.appendChild(item);
    });
  }

  function renderStoryNav() {
    dom.storyNav.replaceChildren();
    story.forEach((step, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "story-nav-button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(index === storyStep));
      button.setAttribute("aria-label", `Step ${index + 1}: ${step.title}`);
      const number = document.createElement("span");
      number.textContent = String(index + 1);
      const label = document.createElement("span");
      label.textContent = step.title;
      button.append(number, label);
      button.addEventListener("click", () => setStoryStep(index));
      dom.storyNav.appendChild(button);
    });
  }

  function setStoryStep(index) {
    storyStep = Math.max(0, Math.min(index, story.length - 1));
    const selected = story[storyStep];
    setText(dom.stepCount, `${storyStep + 1} of ${story.length}`);
    setText(dom.storyStep, `STEP ${storyStep + 1}`);
    setText(dom.storyIcon, selected.icon);
    setText(dom.storyTitle, selected.title);
    setText(dom.storyDescription, selected.description);
    setText(dom.storySay, selected.say);
    dom.storyProgress.style.width = `${((storyStep + 1) / story.length) * 100}%`;
    dom.previousStep.disabled = storyStep === 0;
    dom.nextStep.disabled = storyStep === story.length - 1;
    dom.storyNav.querySelectorAll(".story-nav-button").forEach((button, indexInNav) => {
      button.setAttribute("aria-selected", String(indexInNav === storyStep));
    });
  }

  async function loadStatus() {
    dom.refreshButton.disabled = true;
    dom.refreshButton.classList.add("is-loading");
    try {
      const response = await fetch(`./status.json?refresh=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status request failed: ${response.status}`);
      renderStatus(await response.json());
    } catch {
      renderStatus(fallbackStatus);
    } finally {
      dom.refreshButton.disabled = false;
      dom.refreshButton.classList.remove("is-loading");
    }
  }

  dom.previousStep.addEventListener("click", () => setStoryStep(storyStep - 1));
  dom.nextStep.addEventListener("click", () => setStoryStep(storyStep + 1));
  dom.refreshButton.addEventListener("click", loadStatus);

  renderStoryNav();
  setStoryStep(0);
  loadStatus();
})();

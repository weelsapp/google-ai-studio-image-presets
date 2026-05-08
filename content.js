(() => {
  "use strict";

  if (window.__aispLoaded) return;
  window.__aispLoaded = true;

  const STORAGE_KEY = "aisp-settings-v1";
  const RETRY_KEY = "aisp-retry-pending-v1";
  const DB_NAME = "aisp-reference-images";
  const DB_STORE = "images";

  const DEFAULT_SETTINGS = {
    temperature: "1",
    aspectRatio: "Auto",
    resolution: "1K",
    thinkingLevel: "Minimal",
    outputFormat: "Images only",
    prompt: "",
    promptOpen: false,
    autoApply: true
  };

  const FIELD_LABELS = {
    temperature: "Temperature",
    aspectRatio: "Aspect ratio",
    resolution: "Resolution",
    thinkingLevel: "Thinking level"
  };

  let settings = { ...DEFAULT_SETTINGS };
  let refs = [];
  let root;
  let statusTimer;
  let applyTimer;
  let lastUrl = location.href;
  let lastSignature = "";
  let isApplying = false;
  let audioContext = null;
  let generationActive = false;
  let generationStartedAt = 0;
  let generationWatcher = null;
  let generationStartSnapshot = "";
  let layoutObserver = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalize = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  const textMatches = (el, label) => normalize(el.textContent) === normalize(label);

  const escapeHtml = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const getStorage = (key) =>
    new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key]));
    });

  const setStorage = (key, value) =>
    new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });

  async function loadSettings() {
    const saved = await getStorage(STORAGE_KEY);
    settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    settings.outputFormat = "Images only";
  }

  async function saveSettings() {
    await setStorage(STORAGE_KEY, settings);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbAllImages() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbPutImage(image) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(image);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDeleteImage(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  function showStatus(message) {
    const node = root?.querySelector("[data-aisp-status]");
    if (!node) return;
    node.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      node.textContent = "";
    }, 2200);
  }

  function unlockAudio() {
    if (audioContext) {
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  }

  function playGenerationDoneSound() {
    unlockAudio();
    if (!audioContext || audioContext.state === "suspended") return false;

    const now = audioContext.currentTime;
    const tones = [
      { frequency: 659.25, start: 0, duration: 0.11 },
      { frequency: 880, start: 0.12, duration: 0.14 }
    ];

    tones.forEach((tone) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.frequency, now + tone.start);
      gain.gain.setValueAtTime(0.0001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.18, now + tone.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + tone.start);
      oscillator.stop(now + tone.start + tone.duration + 0.02);
    });

    return true;
  }

  function notifyGenerationDone(reason = "Generation done") {
    generationActive = false;
    if (generationWatcher) {
      clearInterval(generationWatcher);
      generationWatcher = null;
    }

    const played = playGenerationDoneSound();
    showStatus(played ? reason : "Done (audio blocked)");
  }

  function buttonText(button) {
    return normalize([
      button.textContent,
      button.getAttribute("aria-label"),
      button.title
    ].filter(Boolean).join(" "));
  }

  function isDisabledButton(button) {
    return Boolean(button?.disabled) || button?.getAttribute("aria-disabled") === "true";
  }

  function createOption(value) {
    return `<option value="${value}">${value}</option>`;
  }

  function render() {
    root = document.createElement("div");
    root.id = "aisp-root";
    root.className = settings.promptOpen ? "has-prompt" : "";
    root.innerHTML = `
      <div class="aisp-bar">
        <div class="aisp-title">AI Studio Presets</div>
        <div class="aisp-control">
          <label for="aisp-temp">Temp</label>
          <input id="aisp-temp" type="number" min="0" max="2" step="0.1" value="${settings.temperature}">
        </div>
        <div class="aisp-control">
          <label for="aisp-ratio">Ratio</label>
          <select id="aisp-ratio">
            ${["Auto", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"].map(createOption).join("")}
          </select>
        </div>
        <div class="aisp-control">
          <label for="aisp-resolution">Quality</label>
          <select id="aisp-resolution">
            ${["1K", "2K", "4K"].map(createOption).join("")}
          </select>
        </div>
        <div class="aisp-control">
          <label for="aisp-thinking">Thinking</label>
          <select id="aisp-thinking">
            ${["Minimal", "Low", "Medium", "High"].map(createOption).join("")}
          </select>
        </div>
        <label class="aisp-toggle">
          <input id="aisp-auto" type="checkbox">
          Auto
        </label>
        <div class="aisp-drop" data-aisp-drop>
          Drop refs
          <input class="aisp-file" type="file" accept="image/*" multiple>
        </div>
        <div class="aisp-refs" data-aisp-refs></div>
        <button class="aisp-button secondary" data-aisp-prompt-toggle>Prompt</button>
        <button class="aisp-button secondary" data-aisp-apply>Apply</button>
        <div class="aisp-spacer"></div>
        <button class="aisp-button submit" data-aisp-submit>Submit</button>
        <button class="aisp-button retry" data-aisp-retry>Retry</button>
        <div class="aisp-status" data-aisp-status></div>
      </div>
      <div class="aisp-prompt-panel">
        <textarea id="aisp-prompt" spellcheck="false" placeholder="Saved prompt">${escapeHtml(settings.prompt)}</textarea>
        <div class="aisp-prompt-actions">
          <button class="aisp-button secondary" data-aisp-apply-prompt>Apply Prompt</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);
    root.querySelector("#aisp-ratio").value = settings.aspectRatio;
    root.querySelector("#aisp-resolution").value = settings.resolution;
    root.querySelector("#aisp-thinking").value = settings.thinkingLevel;
    root.querySelector("#aisp-auto").checked = settings.autoApply;
    bindUi();
    renderRefs();
    setupLayoutOffset();
  }

  function updateLayoutOffset() {
    if (!root) return;
    const height = Math.ceil(root.getBoundingClientRect().height);
    document.body.classList.add("aisp-layout-offset");
    document.documentElement.style.setProperty("--aisp-offset", `${height}px`);
    document.body.style.setProperty("--aisp-offset", `${height}px`);
  }

  function setupLayoutOffset() {
    updateLayoutOffset();
    if (layoutObserver) layoutObserver.disconnect();

    if ("ResizeObserver" in window) {
      layoutObserver = new ResizeObserver(updateLayoutOffset);
      layoutObserver.observe(root);
    }
    window.addEventListener("resize", updateLayoutOffset);
  }

  function bindUi() {
    const temp = root.querySelector("#aisp-temp");
    const ratio = root.querySelector("#aisp-ratio");
    const resolution = root.querySelector("#aisp-resolution");
    const thinking = root.querySelector("#aisp-thinking");
    const auto = root.querySelector("#aisp-auto");
    const prompt = root.querySelector("#aisp-prompt");
    const file = root.querySelector(".aisp-file");
    const drop = root.querySelector("[data-aisp-drop]");

    root.addEventListener("pointerdown", unlockAudio, { passive: true });
    root.addEventListener("keydown", unlockAudio);

    const persist = async () => {
      settings.temperature = temp.value;
      settings.aspectRatio = ratio.value;
      settings.resolution = resolution.value;
      settings.thinkingLevel = thinking.value;
      settings.outputFormat = "Images only";
      settings.autoApply = auto.checked;
      await saveSettings();
      if (settings.autoApply) scheduleApply(80);
    };

    [temp, ratio, resolution, thinking, auto].forEach((control) => {
      control.addEventListener("change", persist);
    });

    let promptSaveTimer;
    prompt.addEventListener("input", () => {
      settings.prompt = prompt.value;
      clearTimeout(promptSaveTimer);
      promptSaveTimer = setTimeout(async () => {
        await saveSettings();
        applyPrompt(true);
      }, 180);
    });

    root.querySelector("[data-aisp-apply]").addEventListener("click", () => applySettings());
    root.querySelector("[data-aisp-submit]").addEventListener("click", () => submitPrompt());
    root.querySelector("[data-aisp-retry]").addEventListener("click", () => retryFreshChat());
    root.querySelector("[data-aisp-prompt-toggle]").addEventListener("click", async () => {
      settings.promptOpen = !settings.promptOpen;
      await saveSettings();
      root.classList.toggle("has-prompt", settings.promptOpen);
      updateLayoutOffset();
      if (settings.promptOpen) prompt.focus();
    });
    root.querySelector("[data-aisp-apply-prompt]").addEventListener("click", () => applyPrompt(true));

    file.addEventListener("change", async () => {
      await addFiles(file.files);
      file.value = "";
    });

    drop.addEventListener("dragenter", () => drop.classList.add("is-dragging"));
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("is-dragging");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("is-dragging");
      await addFiles(event.dataTransfer.files);
    });
  }

  async function addFiles(fileList) {
    const images = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
    for (const file of images) {
      const dataUrl = await fileToDataUrl(file);
      const image = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        type: file.type,
        dataUrl,
        createdAt: Date.now()
      };
      refs.push(image);
      await dbPutImage(image);
    }
    renderRefs();
    showStatus(images.length ? "Refs saved" : "No image");
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function renderRefs() {
    const list = root?.querySelector("[data-aisp-refs]");
    if (!list) return;
    list.innerHTML = "";
    refs.forEach((ref) => {
      const item = document.createElement("div");
      item.className = "aisp-ref";
      item.title = `${ref.name}\nDrag this thumbnail back into AI Studio if needed.`;
      item.draggable = true;
      item.innerHTML = `<img alt=""><button type="button" aria-label="Remove">x</button>`;
      item.querySelector("img").src = ref.dataUrl;
      item.querySelector("button").addEventListener("click", async () => {
        refs = refs.filter((entry) => entry.id !== ref.id);
        await dbDeleteImage(ref.id);
        renderRefs();
      });
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/uri-list", ref.dataUrl);
        event.dataTransfer.setData("text/plain", ref.name);
      });
      list.appendChild(item);
    });
  }

  function findLabel(label) {
    const target = normalize(label);
    return Array.from(document.querySelectorAll("label, span, div, p, h2, h3"))
      .filter(visible)
      .find((el) => normalize(el.textContent) === target);
  }

  function findNearestContainer(labelEl) {
    let current = labelEl;
    for (let i = 0; i < 6 && current; i += 1) {
      const text = normalize(current.textContent);
      const hasInteractive = current.querySelector("input, button, select, [role='button'], [role='slider'], [role='combobox']");
      if (hasInteractive && text.length < 260) return current;
      current = current.parentElement;
    }
    return labelEl.parentElement || labelEl;
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function getEditableText(el) {
    if (!el) return "";
    if ("value" in el) return el.value || "";
    return el.textContent || "";
  }

  function findPromptInput() {
    const candidates = Array.from(
      document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")
    )
      .filter((el) => !root?.contains(el))
      .filter(visible)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.textContent);
        return rect.width > 240 && (rect.top > window.innerHeight * 0.45 || text.includes("prompt"));
      })
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

    return candidates[0] || null;
  }

  function setEditableText(el, value) {
    if (!el) return false;
    const active = document.activeElement;
    if ("value" in el) {
      setNativeValue(el, value);
      if (active && root?.contains(active) && typeof active.focus === "function") active.focus();
      return true;
    }

    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (active && root?.contains(active) && typeof active.focus === "function") active.focus();
    return true;
  }

  async function applyPrompt(force = false) {
    const prompt = settings.prompt.trim();
    if (!prompt) return false;

    const input = findPromptInput();
    if (!input) return false;

    const current = normalize(getEditableText(input));
    if (!force && current) return true;

    return setEditableText(input, prompt);
  }

  function dataUrlToFile(ref) {
    const [header, payload] = String(ref.dataUrl || "").split(",");
    const mime = header?.match(/data:([^;]+)/)?.[1] || ref.type || "image/png";
    const binary = atob(payload || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], ref.name || "reference.png", { type: mime });
  }

  function buildRefTransfer() {
    if (!refs.length) return null;
    const transfer = new DataTransfer();
    refs.forEach((ref) => transfer.items.add(dataUrlToFile(ref)));
    return transfer;
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"))
      .filter((input) => !root?.contains(input));

    return inputs.find((input) => {
      const accept = normalize(input.getAttribute("accept"));
      return !accept || accept.includes("image") || accept.includes("*");
    }) || inputs[0] || null;
  }

  function dispatchDrop(target, transfer) {
    ["dragenter", "dragover", "drop"].forEach((type) => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      });
      target.dispatchEvent(event);
    });
  }

  async function attachRefs() {
    if (!refs.length) return true;

    const transfer = buildRefTransfer();
    if (!transfer) return false;

    const input = findFileInput();
    if (input) {
      try {
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        showStatus("Refs attached");
        await sleep(900);
        return true;
      } catch (error) {
        // Fall through to the drag/drop path below.
      }
    }

    const promptInput = findPromptInput();
    const target = promptInput?.closest("form, main, section, div") || promptInput || document.body;
    if (!target) return false;

    dispatchDrop(target, transfer);
    showStatus("Refs dropped");
    await sleep(1200);
    return true;
  }

  function findSubmitButton() {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((button) => !root?.contains(button))
      .filter(visible)
      .filter((button) => !isDisabledButton(button));

    const runButton = buttons.find((button) => {
      const text = buttonText(button);
      return text === "run" || text.includes("run");
    });
    if (runButton) return runButton;

    return buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const text = buttonText(button);
        return rect.top > window.innerHeight * 0.5 && (text.includes("send") || text.includes("submit") || text.includes("generate"));
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  function findGenerationControls() {
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((button) => !root?.contains(button))
      .filter(visible)
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const text = buttonText(button);
        return rect.top > window.innerHeight * 0.45 && (
          text.includes("run") ||
          text.includes("stop") ||
          text.includes("cancel") ||
          text.includes("generate")
        );
      });
  }

  function generationLooksRunning() {
    const controls = findGenerationControls();
    if (controls.some((button) => {
      const text = buttonText(button);
      return text.includes("stop") || text.includes("cancel");
    })) return true;

    const runButton = controls.find((button) => {
      const text = buttonText(button);
      return text === "run" || text.includes("run") || text.includes("generate");
    });
    if (runButton && isDisabledButton(runButton)) return true;

    const bodyText = normalize(document.body?.textContent || "");
    return bodyText.includes("generating") || bodyText.includes("running");
  }

  function generationLooksComplete() {
    const button = findSubmitButton();
    return Boolean(button) && !generationLooksRunning();
  }

  function resultSnapshot() {
    const nodes = Array.from(document.querySelectorAll("img, video, canvas, a[href*='download'], button"))
      .filter((node) => !root?.contains(node))
      .filter(visible)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 24 && rect.height > 24 && rect.top > 120;
      })
      .map((node) => [
        node.tagName,
        node.getAttribute("src") || node.getAttribute("href") || "",
        Math.round(node.getBoundingClientRect().top),
        Math.round(node.getBoundingClientRect().left)
      ].join(":"));

    return nodes.join("|");
  }

  function resultsChangedSinceStart() {
    const current = resultSnapshot();
    return Boolean(generationStartSnapshot && current && current !== generationStartSnapshot);
  }

  function startGenerationWatcher() {
    if (generationWatcher) return;

    generationWatcher = setInterval(() => {
      if (!generationActive) return;

      const elapsed = Date.now() - generationStartedAt;
      if (elapsed < 4000) return;

      if (elapsed > 180000) {
        notifyGenerationDone("Generation maybe done");
        return;
      }

      if (generationLooksComplete() && (elapsed > 12000 || resultsChangedSinceStart())) {
        notifyGenerationDone("Generation done");
      }
    }, 1200);
  }

  function markGenerationStarted() {
    generationActive = true;
    generationStartedAt = Date.now();
    generationStartSnapshot = resultSnapshot();
    startGenerationWatcher();
  }

  async function waitForSubmitButton(timeout = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const button = findSubmitButton();
      if (button) return button;
      await sleep(180);
    }
    return null;
  }

  async function submitPrompt() {
    await applySettings();
    await sleep(120);

    const button = await waitForSubmitButton();
    if (!button) {
      showStatus("No submit");
      return false;
    }

    button.click();
    markGenerationStarted();
    showStatus("Submitted");
    return true;
  }

  function findNewChatButton() {
    const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"))
      .filter((button) => !root?.contains(button))
      .filter(visible);

    const explicit = buttons.find((button) => {
      const text = normalize([
        button.textContent,
        button.getAttribute("aria-label"),
        button.title,
        button.href
      ].filter(Boolean).join(" "));
      return text.includes("new chat") || text.includes("new prompt") || text.includes("new conversation");
    });
    if (explicit) return explicit;

    return buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const text = normalize(button.textContent || button.getAttribute("aria-label") || button.title);
        return rect.top < 280 && rect.right > window.innerWidth * 0.55 && (text === "+" || text.includes("add") || text.includes("create"));
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  function goToNewChat() {
    const button = findNewChatButton();
    if (button) {
      button.click();
      return true;
    }

    if (!location.pathname.includes("/prompts/new_chat")) {
      location.assign(`${location.origin}/prompts/new_chat`);
      return true;
    }

    history.pushState(null, "", `${location.origin}/prompts/new_chat?retry=${Date.now()}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  }

  async function retryFreshChat() {
    if (!settings.prompt.trim()) {
      showStatus("No prompt");
      return false;
    }

    await saveSettings();
    await setStorage(RETRY_KEY, { createdAt: Date.now() });
    showStatus("New chat...");
    goToNewChat();
    setTimeout(consumeRetryIfNeeded, 1400);
    return true;
  }

  async function consumeRetryIfNeeded() {
    const retry = await getStorage(RETRY_KEY);
    if (!retry?.createdAt) return false;

    if (Date.now() - retry.createdAt > 30000) {
      await setStorage(RETRY_KEY, null);
      return false;
    }

    const started = Date.now();
    while (Date.now() - started < 10000) {
      const promptInput = findPromptInput();
      const hasSettingsPanel = findLabel(FIELD_LABELS.aspectRatio);
      if (promptInput && hasSettingsPanel) break;
      await sleep(250);
    }

    await setStorage(RETRY_KEY, null);
    showStatus("Retrying...");
    await applySettings();
    await applyPrompt(true);
    await attachRefs();
    await sleep(500);
    return submitPrompt();
  }

  async function applyTemperature(value) {
    const label = findLabel(FIELD_LABELS.temperature);
    if (!label) return false;
    const container = findNearestContainer(label);
    const input = container.querySelector("input[type='range'], input[type='number'], input");
    if (!input) return false;
    setNativeValue(input, value);
    return true;
  }

  function findControlButton(label) {
    const labelEl = findLabel(label);
    if (!labelEl) return null;
    const container = findNearestContainer(labelEl);
    const buttons = Array.from(container.querySelectorAll("button, [role='button'], [role='combobox'], mat-select"));
    return buttons.reverse().find(visible) || null;
  }

  async function clickChoice(label, choice) {
    const button = findControlButton(label);
    if (!button) return false;

    if (normalize(button.textContent).includes(normalize(choice))) return true;

    button.click();
    await sleep(180);

    const candidates = Array.from(
      document.querySelectorAll("[role='option'], mat-option, button, [role='menuitem'], li, div, span")
    ).filter(visible);
    const option = candidates
      .filter((el) => normalize(el.textContent) === normalize(choice))
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];

    if (!option) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }

    option.click();
    await sleep(120);
    return true;
  }

  async function clickSegment(label) {
    const target = Array.from(document.querySelectorAll("button, [role='button'], mat-button-toggle, div"))
      .filter(visible)
      .find((el) => textMatches(el, label));
    if (!target) return false;
    target.click();
    await sleep(100);
    return true;
  }

  async function applySettings() {
    if (isApplying) return 0;
    isApplying = true;
    showStatus("Applying...");

    try {
      const results = [];
      results.push(await applyTemperature(settings.temperature));
      results.push(await clickChoice(FIELD_LABELS.aspectRatio, settings.aspectRatio));
      results.push(await clickChoice(FIELD_LABELS.resolution, settings.resolution));
      results.push(await clickChoice(FIELD_LABELS.thinkingLevel, settings.thinkingLevel));
      results.push(await clickSegment("Images only"));
      results.push(await applyPrompt(false));

      const okCount = results.filter(Boolean).length;
      showStatus(okCount ? `Applied ${okCount}/6` : "Not found");
      return okCount;
    } finally {
      isApplying = false;
    }
  }

  function signature() {
    return [
      location.href,
      Boolean(findLabel(FIELD_LABELS.aspectRatio)),
      Boolean(findPromptInput())
    ].join("|");
  }

  function scheduleApply(delay = 500) {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      if (settings.autoApply) applySettings();
    }, delay);
  }

  function watchNavigation() {
    const observer = new MutationObserver((mutations) => {
      if (!settings.autoApply) return;
      if (mutations.every((mutation) => root?.contains(mutation.target))) return;
      const currentSignature = signature();
      if (location.href !== lastUrl || currentSignature !== lastSignature) {
        lastUrl = location.href;
        lastSignature = currentSignature;
        scheduleApply(900);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    lastSignature = signature();

    const push = history.pushState;
    history.pushState = function patchedPushState(...args) {
      const result = push.apply(this, args);
      scheduleApply(500);
      return result;
    };
    window.addEventListener("popstate", () => scheduleApply(500));
  }

  function watchExternalSubmits() {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button, [role='button']");
      if (!button || root?.contains(button) || !visible(button) || isDisabledButton(button)) return;

      const text = buttonText(button);
      const rect = button.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.45 && (text === "run" || text.includes("run") || text.includes("generate"))) {
        unlockAudio();
        setTimeout(markGenerationStarted, 300);
      }
    }, true);
  }

  async function boot() {
    await loadSettings();
    refs = await dbAllImages().catch(() => []);
    render();
    watchNavigation();
    watchExternalSubmits();
    scheduleApply(900);
    setTimeout(consumeRetryIfNeeded, 1100);
  }

  boot();
})();

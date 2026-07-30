(function (root) {
  "use strict";

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / (1024 ** unitIndex);
    return `${amount.toFixed(unitIndex === 0 || amount >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function sanitizeFilename(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.\s]+$/g, "")
      .replace(/\.pdf$/i, "")
      .trim();
    return cleaned || "合併文件";
  }

  function buildDecryptedFilename(filename) {
    return `${sanitizeFilename(filename)}_已解密.pdf`;
  }

  function getTargetRotation(width, height, currentRotation, targetOrientation) {
    const angle = ((Number(currentRotation) || 0) % 360 + 360) % 360;
    const isQuarterTurn = angle % 180 !== 0;
    const effectiveWidth = isQuarterTurn ? height : width;
    const effectiveHeight = isQuarterTurn ? width : height;
    const currentOrientation = effectiveWidth > effectiveHeight ? "landscape" : "portrait";
    if (targetOrientation !== "portrait" && targetOrientation !== "landscape") return angle;
    return currentOrientation === targetOrientation ? angle : (angle + 90) % 360;
  }

  function moveItem(items, fromIndex, toIndex) {
    if (!Array.isArray(items) || fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
      return [...items];
    }
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }

  function summarizeFiles(items) {
    return {
      files: items.length,
      pages: items.reduce((total, item) => total + (item.pageCount || 0), 0),
      bytes: items.reduce((total, item) => total + ((item.file && item.file.size) || 0), 0),
    };
  }

  function isFileDrag(dataTransfer) {
    return Array.from((dataTransfer && dataTransfer.types) || [])
      .some((type) => String(type).toLowerCase() === "files");
  }

  const assetPromises = new Map();

  function loadScriptOnce(src) {
    if (assetPromises.has(src)) return assetPromises.get(src);
    if (typeof document === "undefined") {
      return Promise.reject(new Error(`無法載入瀏覽器資源：${src}`));
    }
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`資源載入失敗：${src}`));
      document.head.appendChild(script);
    });
    assetPromises.set(src, promise);
    return promise;
  }

  async function readFileBuffer(file, onProgress) {
    if (typeof root.FileReader !== "function") {
      const buffer = await file.arrayBuffer();
      if (onProgress) onProgress(file.size || buffer.byteLength, file.size || buffer.byteLength);
      return buffer;
    }
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onprogress = (event) => {
        if (onProgress) onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
      };
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("檔案讀取失敗"));
      reader.onabort = () => reject(new Error("檔案讀取已取消"));
      reader.readAsArrayBuffer(file);
    });
  }

  let qpdfPromise = null;
  let qpdfAssetPromise = null;
  let qpdfWasmUrl = "";
  let qpdfOutput = [];
  let qpdfErrors = [];

  function base64ToBytes(base64) {
    const binary = root.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function ensureQpdfAssets() {
    if (typeof root.Module === "function" && root.QPDF_WASM_BASE64) return;
    if (!qpdfAssetPromise) {
      qpdfAssetPromise = (async () => {
        if (!root.QPDF_WASM_BASE64) {
          await loadScriptOnce("vendor/qpdf-wasm-base64.js?v=1.8.0");
        }
        if (typeof root.Module !== "function") {
          await loadScriptOnce("vendor/qpdf.js?v=1.8.0");
        }
      })();
    }
    await qpdfAssetPromise;
  }

  async function getQpdfModule() {
    if (qpdfPromise) return qpdfPromise;
    await ensureQpdfAssets();
    if (qpdfPromise) return qpdfPromise;
    if (typeof root.Module !== "function") {
      throw new Error("QPDF 引擎尚未載入");
    }

    let wasmLocation = root.QPDF_WASM_PATH;
    if (!wasmLocation) {
      if (!root.QPDF_WASM_BASE64 || typeof Blob === "undefined" || !root.URL) {
        return Promise.reject(new Error("QPDF WebAssembly 尚未載入"));
      }
      const wasmBlob = new Blob([base64ToBytes(root.QPDF_WASM_BASE64)], {
        type: "application/wasm",
      });
      qpdfWasmUrl = URL.createObjectURL(wasmBlob);
      wasmLocation = qpdfWasmUrl;
    }

    qpdfPromise = root.Module({
      locateFile: () => wasmLocation,
      noInitialRun: true,
      print: (message) => qpdfOutput.push(String(message)),
      printErr: (message) => qpdfErrors.push(String(message)),
    });
    return qpdfPromise;
  }

  let pdfPreviewAssetPromise = null;

  async function ensurePdfPreviewEngine() {
    if (!root.pdfjsLib) {
      if (!pdfPreviewAssetPromise) {
        pdfPreviewAssetPromise = loadScriptOnce("vendor/pdf.min.js?v=1.8.0");
      }
      await pdfPreviewAssetPromise;
    }
    if (!root.pdfjsLib) throw new Error("PDF 預覽引擎尚未載入");
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js?v=1.8.0";
    return root.pdfjsLib;
  }

  async function decryptPdfBytes(bytes, password) {
    if (!password) {
      const error = new Error("此 PDF 需要密碼");
      error.code = "PDF_PASSWORD_REQUIRED";
      throw error;
    }

    const qpdf = await getQpdfModule();
    const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const inputPath = `/locked_${token}.pdf`;
    const outputPath = `/unlocked_${token}.pdf`;
    qpdfOutput = [];
    qpdfErrors = [];

    try {
      qpdf.FS.writeFile(inputPath, new Uint8Array(bytes));
      const exitCode = qpdf.callMain([
        `--password=${password}`,
        "--decrypt",
        "--",
        inputPath,
        outputPath,
      ]);
      if (exitCode && exitCode !== 0) {
        throw new Error(qpdfErrors.join("\n") || `QPDF 結束代碼 ${exitCode}`);
      }
      const output = qpdf.FS.readFile(outputPath);
      return new Uint8Array(output);
    } catch (cause) {
      const error = new Error("PDF 密碼錯誤或不支援此加密格式");
      error.code = "PDF_PASSWORD_FAILED";
      error.cause = cause;
      throw error;
    } finally {
      try { qpdf.FS.unlink(inputPath); } catch {}
      try { qpdf.FS.unlink(outputPath); } catch {}
    }
  }

  async function decryptPdfBatch(items, password, decryptor) {
    const decrypt = decryptor || decryptPdfBytes;
    const results = [];
    for (const item of items || []) {
      try {
        results.push({
          id: item.id,
          ok: true,
          bytes: await decrypt(item.bytes, password),
        });
      } catch (error) {
        results.push({ id: item.id, ok: false, error });
      }
    }
    return results;
  }

  function isEncryptedPdfError(error) {
    return Boolean(
      error &&
      (error.name === "EncryptedPDFError" || /encrypted/i.test(String(error.message || "")))
    );
  }

  async function mergePdfBuffers(buffers, metadata) {
    if (!Array.isArray(buffers) || !buffers.length) throw new Error("至少需要一份 PDF");
    if (!root.PDFLib || !root.PDFLib.PDFDocument) throw new Error("PDF 引擎尚未載入");

    const mergedPdf = await root.PDFLib.PDFDocument.create();
    for (const bytes of buffers) {
      const sourcePdf = await root.PDFLib.PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
      });
      const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
      pages.forEach((page) => {
        if (metadata && metadata.orientation) {
          const { width, height } = page.getSize();
          page.setRotation(root.PDFLib.degrees(getTargetRotation(
            width,
            height,
            page.getRotation().angle,
            metadata.orientation
          )));
        }
        mergedPdf.addPage(page);
      });
    }
    if (metadata && metadata.title) mergedPdf.setTitle(metadata.title);
    mergedPdf.setProducer("HTML Tools / 合頁 PDF 工具");
    mergedPdf.setCreator("HTML Tools / 合頁 PDF 工具");
    return { bytes: await mergedPdf.save(), pageCount: mergedPdf.getPageCount() };
  }

  const utils = {
    formatBytes,
    sanitizeFilename,
    buildDecryptedFilename,
    getTargetRotation,
    moveItem,
    summarizeFiles,
    isFileDrag,
    readFileBuffer,
    decryptPdfBytes,
    decryptPdfBatch,
    isEncryptedPdfError,
    mergePdfBuffers,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = utils;
  root.PdfMergerUtils = utils;
  if (!root.Vue || !root.PDFLib || typeof document === "undefined") return;

  const { createApp, ref, computed, nextTick, onMounted, onBeforeUnmount } = root.Vue;

  createApp({
    setup() {
      const queue = ref([]);
      const fileInput = ref(null);
      const outputName = ref("合併文件");
      const normalizeOrientation = ref(false);
      const pageOrientation = ref("portrait");
      const dragActive = ref(false);
      const isReading = ref(false);
      const readProgress = ref({
        current: 0,
        total: 0,
        percent: 0,
        fileName: "",
        phase: "",
      });
      const isBusy = ref(false);
      const isUnlocking = ref(false);
      const isBatchUnlocking = ref(false);
      const isPreviewing = ref(false);
      const draggedId = ref(null);
      const toastMessage = ref("");
      const toastType = ref("info");
      const showChangelog = ref(false);
      const unlockTarget = ref(null);
      const unlockPassword = ref("");
      const unlockPasswordInput = ref(null);
      const showUnlockPassword = ref(false);
      const unlockError = ref("");
      const selectedLockedIds = ref([]);
      const batchUnlockOpen = ref(false);
      const batchUnlockPassword = ref("");
      const batchUnlockPasswordInput = ref(null);
      const showBatchUnlockPassword = ref(false);
      const batchUnlockError = ref("");
      const batchUnlockProgress = ref("");
      const previewUrl = ref("");
      const previewTitle = ref("");
      const previewPageCount = ref(0);
      const previewContainer = ref(null);
      const previewLoading = ref(false);
      const previewError = ref("");
      const theme = ref(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light"
      );
      let toastTimer = null;
      let previewDocument = null;
      let previewRenderToken = 0;
      const summary = computed(() => summarizeFiles(queue.value));
      const lockedCount = computed(() => queue.value.filter((item) => item.locked).length);
      const hasLockedFiles = computed(() => lockedCount.value > 0);
      const selectedLockedItems = computed(() => queue.value.filter(
        (item) => item.locked && selectedLockedIds.value.includes(item.id)
      ));
      const selectedLockedCount = computed(() => selectedLockedItems.value.length);
      const allLockedSelected = computed(() => (
        lockedCount.value > 0 && selectedLockedCount.value === lockedCount.value
      ));
      const isDarkMode = computed(() => theme.value === "dark");

      function showToast(message, type) {
        clearTimeout(toastTimer);
        toastMessage.value = message;
        toastType.value = type || "info";
        toastTimer = setTimeout(() => { toastMessage.value = ""; }, 3600);
      }

      function openFilePicker() {
        if (!isBusy.value && !isReading.value && fileInput.value) fileInput.value.click();
      }

      function toggleTheme() {
        theme.value = isDarkMode.value ? "light" : "dark";
        if (root.PdfMergerTheme) {
          root.PdfMergerTheme.applyTheme(theme.value, true);
        } else {
          document.documentElement.dataset.theme = theme.value;
        }
      }

      async function readPdf(file, onProgress) {
        const bytes = await readFileBuffer(file, onProgress);
        let pdf;
        let locked = false;

        try {
          pdf = await root.PDFLib.PDFDocument.load(bytes, {
            ignoreEncryption: false,
            updateMetadata: false,
          });
        } catch (error) {
          if (!isEncryptedPdfError(error)) throw error;
          locked = true;
        }

        return {
          id: root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          file,
          bytes,
          pageCount: pdf ? pdf.getPageCount() : 0,
          locked,
          unlocked: false,
        };
      }

      async function addFiles(fileList) {
        if (isBusy.value || isReading.value) return;
        const files = Array.from(fileList || []);
        const pdfFiles = files.filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
        if (!pdfFiles.length) {
          showToast("請選擇 PDF 格式的檔案。", "error");
          return;
        }

        isReading.value = true;
        const results = [];
        const totalBytes = pdfFiles.reduce((total, file) => total + (file.size || 0), 0);
        let completedBytes = 0;
        for (let index = 0; index < pdfFiles.length; index += 1) {
          const file = pdfFiles[index];
          readProgress.value = {
            current: index + 1,
            total: pdfFiles.length,
            percent: totalBytes ? Math.round((completedBytes / totalBytes) * 100) : 0,
            fileName: file.name,
            phase: "讀取中",
          };
          try {
            const item = await readPdf(file, (loaded) => {
              readProgress.value = {
                ...readProgress.value,
                percent: totalBytes
                  ? Math.min(99, Math.round(((completedBytes + loaded) / totalBytes) * 100))
                  : 0,
              };
            });
            readProgress.value = { ...readProgress.value, phase: "分析完成" };
            results.push({ status: "fulfilled", value: item });
          } catch (reason) {
            results.push({ status: "rejected", reason });
          }
          completedBytes += file.size || 0;
          readProgress.value = {
            ...readProgress.value,
            percent: totalBytes ? Math.round((completedBytes / totalBytes) * 100) : 100,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 240));
        const accepted = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
        const rejected = results.filter((result) => result.status === "rejected");
        const rejectedCount = rejected.length;
        queue.value = [...queue.value, ...accepted];
        isReading.value = false;
        readProgress.value = { current: 0, total: 0, percent: 0, fileName: "", phase: "" };
        if (fileInput.value) fileInput.value.value = "";

        if (rejectedCount) {
          showToast(`有 ${rejectedCount} 份 PDF 無法讀取，可能已損毀。`, "error");
        } else {
          const encryptedCount = accepted.filter((item) => item.locked).length;
          if (encryptedCount) {
            showToast(
              `已顯示 ${accepted.length} 份 PDF，其中 ${encryptedCount} 份已加密。可單檔解密或勾選後批次處理。`,
              "success"
            );
          } else if (files.length !== pdfFiles.length) {
            showToast("已加入 PDF，並略過非 PDF 格式的檔案。", "success");
          } else {
            showToast(`已加入 ${accepted.length} 份 PDF。`, "success");
          }
        }
      }

      function handleFileInput(event) { addFiles(event.target.files); }

      function handlePageDragEnter(event) {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        dragActive.value = !isBusy.value && !isReading.value;
      }

      function handlePageDragOver(event) {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = isBusy.value || isReading.value ? "none" : "copy";
        }
        dragActive.value = !isBusy.value && !isReading.value;
      }

      function handlePageDragLeave(event) {
        if (!dragActive.value) return;
        if (event.relatedTarget && document.documentElement.contains(event.relatedTarget)) return;
        dragActive.value = false;
      }

      function handlePageDrop(event) {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        dragActive.value = false;
        addFiles(event.dataTransfer.files);
      }

      function resetPageDrag() { dragActive.value = false; }

      function moveBy(index, direction) { queue.value = moveItem(queue.value, index, index + direction); }
      function removeFile(id) {
        if (unlockTarget.value && unlockTarget.value.id === id) closeUnlockDialog();
        selectedLockedIds.value = selectedLockedIds.value.filter((selectedId) => selectedId !== id);
        queue.value = queue.value.filter((item) => item.id !== id);
        if (batchUnlockOpen.value && !selectedLockedCount.value) closeBatchUnlockDialog();
      }
      function clearAll() {
        closeUnlockDialog();
        closeBatchUnlockDialog();
        closePreview();
        selectedLockedIds.value = [];
        queue.value = [];
      }

      function openUnlockDialog(item) {
        unlockTarget.value = item;
        unlockPassword.value = "";
        showUnlockPassword.value = false;
        unlockError.value = "";
        nextTick(() => {
          if (unlockPasswordInput.value) unlockPasswordInput.value.focus();
        });
      }

      function closeUnlockDialog() {
        if (isUnlocking.value) return;
        unlockTarget.value = null;
        unlockPassword.value = "";
        unlockError.value = "";
      }

      function toggleAllLocked(event) {
        if (event && event.target && event.target.checked) {
          selectedLockedIds.value = queue.value.filter((item) => item.locked).map((item) => item.id);
        } else {
          selectedLockedIds.value = [];
        }
      }

      function openBatchUnlockDialog() {
        if (!selectedLockedCount.value || isBatchUnlocking.value) return;
        batchUnlockOpen.value = true;
        batchUnlockPassword.value = "";
        showBatchUnlockPassword.value = false;
        batchUnlockError.value = "";
        batchUnlockProgress.value = "";
        nextTick(() => {
          if (batchUnlockPasswordInput.value) batchUnlockPasswordInput.value.focus();
        });
      }

      function closeBatchUnlockDialog() {
        if (isBatchUnlocking.value) return;
        batchUnlockOpen.value = false;
        batchUnlockPassword.value = "";
        batchUnlockError.value = "";
        batchUnlockProgress.value = "";
      }

      async function unlockSelected() {
        const target = unlockTarget.value;
        if (!target || isUnlocking.value) return;
        if (!unlockPassword.value) {
          unlockError.value = "請輸入這份 PDF 的已知密碼。";
          if (unlockPasswordInput.value) unlockPasswordInput.value.focus();
          return;
        }

        isUnlocking.value = true;
        unlockError.value = "";
        try {
          const unlockedBytes = await decryptPdfBytes(target.bytes, unlockPassword.value);
          const pdf = await root.PDFLib.PDFDocument.load(unlockedBytes, {
            ignoreEncryption: false,
            updateMetadata: false,
          });
          queue.value = queue.value.map((item) => (
            item.id === target.id
              ? {
                ...item,
                bytes: unlockedBytes,
                pageCount: pdf.getPageCount(),
                locked: false,
                unlocked: true,
              }
              : item
          ));
          selectedLockedIds.value = selectedLockedIds.value.filter((id) => id !== target.id);
          const filename = target.file.name;
          isUnlocking.value = false;
          closeUnlockDialog();
          showToast(`${filename} 已去除密碼。`, "success");
        } catch (error) {
          unlockError.value = error && error.code === "PDF_PASSWORD_FAILED"
            ? "密碼錯誤或不支援此加密格式，請重新確認。"
            : "去除密碼失敗，請稍後再試。";
        } finally {
          isUnlocking.value = false;
        }
      }

      async function unlockSelectedBatch() {
        const targets = [...selectedLockedItems.value];
        if (!targets.length || isBatchUnlocking.value) return;
        if (!batchUnlockPassword.value) {
          batchUnlockError.value = "請輸入這批 PDF 的已知密碼。";
          if (batchUnlockPasswordInput.value) batchUnlockPasswordInput.value.focus();
          return;
        }

        isBatchUnlocking.value = true;
        batchUnlockError.value = "";
        batchUnlockProgress.value = `正在處理 1 / ${targets.length}`;
        const password = batchUnlockPassword.value;
        let processedCount = 0;
        const results = await decryptPdfBatch(targets, password, async (bytes, knownPassword) => {
          batchUnlockProgress.value = `正在處理 ${processedCount + 1} / ${targets.length}`;
          try {
            return await decryptPdfBytes(bytes, knownPassword);
          } finally {
            processedCount += 1;
          }
        });

        const successful = new Map();
        const failedIds = [];
        for (const result of results) {
          if (!result.ok) {
            failedIds.push(result.id);
            continue;
          }
          try {
            const pdf = await root.PDFLib.PDFDocument.load(result.bytes, {
              ignoreEncryption: false,
              updateMetadata: false,
            });
            successful.set(result.id, {
              bytes: result.bytes,
              pageCount: pdf.getPageCount(),
            });
          } catch {
            failedIds.push(result.id);
          }
        }

        queue.value = queue.value.map((item) => {
          const unlocked = successful.get(item.id);
          return unlocked
            ? {
              ...item,
              bytes: unlocked.bytes,
              pageCount: unlocked.pageCount,
              locked: false,
              unlocked: true,
            }
            : item;
        });
        selectedLockedIds.value = failedIds;
        isBatchUnlocking.value = false;
        batchUnlockProgress.value = "";

        if (!failedIds.length) {
          const count = successful.size;
          closeBatchUnlockDialog();
          showToast(`已批次去除 ${count} 份 PDF 的密碼。`, "success");
          return;
        }

        batchUnlockPassword.value = "";
        batchUnlockError.value = successful.size
          ? `已完成 ${successful.size} 份；另有 ${failedIds.length} 份密碼不同或不支援，已保留勾選。`
          : `這 ${failedIds.length} 份 PDF 的密碼錯誤或不支援，請重新確認。`;
        nextTick(() => {
          if (batchUnlockPasswordInput.value) batchUnlockPasswordInput.value.focus();
        });
      }

      function downloadUnlocked(item) {
        const blob = new Blob([item.bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const downloadName = buildDecryptedFilename(item.file.name);
        link.href = url;
        link.download = downloadName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`${downloadName} 已下載。`, "success");
      }

      function openPreview(bytes, title, pageCount) {
        closePreview();
        const blob = new Blob([bytes], { type: "application/pdf" });
        previewUrl.value = URL.createObjectURL(blob);
        previewTitle.value = title;
        previewPageCount.value = pageCount;
        previewLoading.value = true;
        const token = previewRenderToken;
        nextTick(() => renderPdfPreview(bytes, token));
      }

      function closePreview() {
        previewRenderToken += 1;
        if (previewDocument && typeof previewDocument.destroy === "function") {
          previewDocument.destroy();
        }
        previewDocument = null;
        if (previewContainer.value) previewContainer.value.replaceChildren();
        if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
        previewUrl.value = "";
        previewTitle.value = "";
        previewPageCount.value = 0;
        previewLoading.value = false;
        previewError.value = "";
      }

      async function renderPdfPreview(bytes, token) {
        const container = previewContainer.value;
        if (!container) {
          previewLoading.value = false;
          previewError.value = "PDF 預覽引擎尚未載入。";
          return;
        }
        container.replaceChildren();
        try {
          await ensurePdfPreviewEngine();
          const loadingTask = root.pdfjsLib.getDocument({
            data: new Uint8Array(bytes).slice(),
          });
          const pdf = await loadingTask.promise;
          if (token !== previewRenderToken) {
            pdf.destroy();
            return;
          }
          previewDocument = pdf;
          previewPageCount.value = pdf.numPages;

          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            if (token !== previewRenderToken) return;
            const baseViewport = page.getViewport({ scale: 1 });
            const availableWidth = Math.max(240, Math.min(container.clientWidth - 32, 980));
            const scale = Math.min(1.6, availableWidth / baseViewport.width);
            const viewport = page.getViewport({ scale });
            const pixelRatio = Math.min(root.devicePixelRatio || 1, 2);
            const pageShell = document.createElement("div");
            pageShell.className = "preview-page";
            const pageBadge = document.createElement("span");
            pageBadge.className = "preview-page-number";
            pageBadge.textContent = `${pageNumber} / ${pdf.numPages}`;
            const canvas = document.createElement("canvas");
            canvas.setAttribute("aria-label", `第 ${pageNumber} 頁`);
            canvas.width = Math.floor(viewport.width * pixelRatio);
            canvas.height = Math.floor(viewport.height * pixelRatio);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            pageShell.append(pageBadge, canvas);
            container.appendChild(pageShell);
            const canvasContext = canvas.getContext("2d");
            await page.render({
              canvasContext,
              viewport,
              transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
            }).promise;
          }
        } catch (error) {
          if (token !== previewRenderToken) return;
          console.error(error);
          previewError.value = "PDF 預覽失敗，可使用「另開視窗」查看。";
        } finally {
          if (token === previewRenderToken) previewLoading.value = false;
        }
      }

      function previewItem(item) {
        if (item.locked) {
          showToast("請先去除這份 PDF 的密碼。", "error");
          return;
        }
        openPreview(item.bytes, item.file.name, item.pageCount);
      }

      function createCurrentMerge() {
        return mergePdfBuffers(queue.value.map((item) => item.bytes), {
          title: sanitizeFilename(outputName.value),
          orientation: normalizeOrientation.value ? pageOrientation.value : null,
        });
      }

      async function previewMerged() {
        if (!queue.value.length || isBusy.value || isPreviewing.value) return;
        if (hasLockedFiles.value) {
          showToast("請先為所有加密 PDF 去除密碼。", "error");
          return;
        }
        isPreviewing.value = true;
        try {
          const result = await createCurrentMerge();
          openPreview(
            result.bytes,
            `${sanitizeFilename(outputName.value)} · 合併預覽`,
            result.pageCount
          );
        } catch (error) {
          console.error(error);
          showToast("預覽產生失敗，請檢查 PDF 後再試一次。", "error");
        } finally {
          isPreviewing.value = false;
        }
      }

      function startDrag(id, event) {
        draggedId.value = id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
      function endDrag() { draggedId.value = null; }
      function dropAt(targetId, event) {
        const fromIndex = queue.value.findIndex((item) => item.id === draggedId.value);
        let toIndex = queue.value.findIndex((item) => item.id === targetId);
        if (fromIndex < 0 || toIndex < 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        if (after && fromIndex > toIndex) toIndex += 1;
        if (!after && fromIndex < toIndex) toIndex -= 1;
        queue.value = moveItem(queue.value, fromIndex, toIndex);
        endDrag();
      }

      async function mergeAndDownload() {
        if (!queue.value.length || isBusy.value) return;
        if (hasLockedFiles.value) {
          showToast("請先為所有加密 PDF 去除密碼。", "error");
          return;
        }
        isBusy.value = true;
        try {
          const result = await createCurrentMerge();
          const blob = new Blob([result.bytes], { type: "application/pdf" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${sanitizeFilename(outputName.value)}.pdf`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          showToast(`合併完成，共 ${result.pageCount} 頁。`, "success");
        } catch (error) {
          console.error(error);
          showToast("合併失敗，請移除加密或損毀的 PDF 後再試一次。", "error");
        } finally {
          isBusy.value = false;
        }
      }

      onMounted(() => {
        document.addEventListener("dragenter", handlePageDragEnter);
        document.addEventListener("dragover", handlePageDragOver);
        document.addEventListener("dragleave", handlePageDragLeave);
        document.addEventListener("drop", handlePageDrop);
        window.addEventListener("blur", resetPageDrag);
      });

      onBeforeUnmount(() => {
        closePreview();
        document.removeEventListener("dragenter", handlePageDragEnter);
        document.removeEventListener("dragover", handlePageDragOver);
        document.removeEventListener("dragleave", handlePageDragLeave);
        document.removeEventListener("drop", handlePageDrop);
        window.removeEventListener("blur", resetPageDrag);
      });

      return {
        queue, fileInput, outputName, normalizeOrientation, pageOrientation,
        dragActive, isReading, readProgress, isBusy, isUnlocking, isBatchUnlocking, isPreviewing, draggedId,
        toastMessage, toastType, showChangelog, unlockTarget, unlockPassword, unlockPasswordInput,
        showUnlockPassword, unlockError, theme, isDarkMode, summary, lockedCount, hasLockedFiles,
        selectedLockedIds, batchUnlockOpen, batchUnlockPassword, batchUnlockPasswordInput,
        showBatchUnlockPassword, batchUnlockError, batchUnlockProgress,
        selectedLockedCount, selectedLockedItems, allLockedSelected,
        previewUrl, previewTitle, previewPageCount, previewContainer, previewLoading, previewError,
        formatBytes, openFilePicker, toggleTheme, openUnlockDialog, closeUnlockDialog, unlockSelected,
        toggleAllLocked, openBatchUnlockDialog, closeBatchUnlockDialog, unlockSelectedBatch,
        handleFileInput, moveBy, removeFile, clearAll, downloadUnlocked,
        openPreview, closePreview, previewItem, previewMerged, startDrag, endDrag,
        dropAt, mergeAndDownload,
      };
    },
  }).mount("#app");
})(typeof window !== "undefined" ? window : globalThis);

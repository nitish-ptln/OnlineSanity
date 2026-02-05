/**
 * Telephony Manager - Client App
 * Handles dynamic command management, device status, and test execution.
 */

class TelephonyManager {
    constructor() {
        this.results = {};
        this.currentModel = 'toyota';
        this.currentFilter = 'all';
        this.adbCommand = 'adb1';
        this.deviceConnected = false;
        this.simState = -1; // -1: Unk, 1: Absent, 5: Ready
        this.resultsByModel = {}; // Cache results per model
        this.stopExecution = false;
        this.isPaused = false;
        this.isRunningAll = false;

        // Session identification for multi-device support
        this.clientId = sessionStorage.getItem('clientId');
        if (!this.clientId) {
            this.clientId = 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
            sessionStorage.setItem('clientId', this.clientId);
        }

        this.modelIcons = {
            toyota: '🚙',
            honda: '🚗',
            gen12: '🚕',
            jlr: '🏎️',
            bmw: '🏙️',
            default: '🚘'
        };

        // Data from server
        this.commandsData = null;
        this.categoriesData = null;
        this.adminToken = localStorage.getItem('adminToken') || null;
        this.adminUser = localStorage.getItem('adminUser') || null;
        this.stopExecution = false;
        this.isRunningAll = false;
        this.deviceSerial = localStorage.getItem('adbSerial') || '';
        this.activeCallMonitor = null; // Track active call monitoring interval
        this.cachedSwVersion = null; // Cache SW version to reduce polling
        this.stopRegression = false;
        this.isRegressionRunning = false;
        this.isRegressionPaused = false;
        this.regressionHistory = []; // Store detailed run data for export

        // DLT Settings
        this.dltPort = localStorage.getItem('dltPort') || '3490';

        this.init();
    }

    async apiCall(url, options = {}) {
        options.headers = options.headers || {};
        options.headers['X-Client-ID'] = this.clientId;
        if (this.adminToken) {
            options.headers['Authorization'] = this.adminToken;
        }
        return fetch(url, options);
    }

    async init() {
        try {
            await this.loadAllStaticData();
            if (this.commandsData) {
                this.renderModels();
                this.loadFilterTabs();
                this.loadCommands();
                this.updateStats(); // Initial stats
                this.updateModuleVisibility();
                this.updateAdminUI();
                await this.loadConfig(); // Load server config
            }
        } catch (e) { console.error('Static data load failed', e); }

        // Set DLT sidebar text
        const dltText = document.getElementById('dltCurrentConfig');
        if (dltText) dltText.textContent = `Bridge: ${this.dltPort}`;

        try { this.bindEvents(); } catch (e) { console.error('Event binding failed', e); }

        // Non-blocking background tasks
        this.fetchDevices().then(() => {
            if (this.deviceSerial) {
                this.handleDeviceChange(this.deviceSerial, false);
            }
        }).catch(e => console.error(e));

        this.checkDeviceStatus().catch(e => console.error(e));

        setInterval(() => this.checkDeviceStatus(), 5000);
        setInterval(() => this.fetchDevices(), 15000);
    }

    async loadAllStaticData() {
        try {
            const response = await this.apiCall('/api/commands');
            const data = await response.json();
            this.commandsData = data.commands;
            this.categoriesData = data.categories;
        } catch (e) {
            console.error('Failed to load commands data', e);
            this.showToast('Failed to load commands data', false);
        }
    }

    renderModels() {
        const list = document.querySelector('.model-list');
        list.innerHTML = '';

        Object.entries(this.commandsData).forEach(([id, model]) => {
            const li = document.createElement('li');
            li.className = `model-item ${id === this.currentModel ? 'active' : ''}`;
            li.dataset.model = id;
            const icon = this.modelIcons[id] || this.modelIcons.default;
            li.innerHTML = `
                <span class="model-icon">${icon}</span>
                <div class="model-info">
                    <span class="model-name">${model.name}</span>
                    <span class="model-variant">${model.variant || ''}</span>
                </div>
            `;
            li.addEventListener('click', () => this.handleModelSwitch(id));
            list.appendChild(li);
        });

        document.getElementById('currentModel').textContent = this.commandsData[this.currentModel].name;
    }

    handleModelSwitch(newId) {
        if (newId === this.currentModel) return;

        const oldName = this.commandsData[this.currentModel].name;
        const newName = this.commandsData[newId].name;

        this.pendingModelSwitch = newId;
        document.getElementById('oldModelName').textContent = oldName;
        document.getElementById('newModelName').textContent = newName;
        document.getElementById('confirmSwitchModal').classList.add('active');
    }

    async confirmSwitch() {
        // Save current results before switching
        this.resultsByModel[this.currentModel] = { ...this.results };

        this.currentModel = this.pendingModelSwitch;
        // Restore results for the new model if they exist
        this.results = this.resultsByModel[this.currentModel] || {};
        this.currentFilter = 'all';

        // Clear report container to avoid showing old model's report
        const reportContainer = document.getElementById('reportTableData');
        if (reportContainer) reportContainer.innerHTML = '';

        // Update UI
        document.querySelectorAll('.model-item').forEach(item => {
            item.classList.toggle('active', item.dataset.model === this.currentModel);
        });

        document.getElementById('currentModel').textContent = this.commandsData[this.currentModel].name;

        this.loadFilterTabs();
        this.loadCommands();
        this.updateStats();
        this.updateModuleVisibility();
        this.closeSwitchModal();

        // If report controls exist, update them
        if (document.getElementById('reportStatsBar')) {
            this.updateReportStats();
        }

        this.showToast(`Switched to ${this.commandsData[this.currentModel].name}`, true);
    }

    closeSwitchModal() {
        document.getElementById('confirmSwitchModal').classList.remove('active');
        this.pendingModelSwitch = null;
    }

    bindEvents() {
        // Sidebar Toggle for Mobile
        const sidebar = document.querySelector('.sidebar');
        const sidebarToggle = document.getElementById('sidebarToggle');
        const mainContent = document.querySelector('.main-content');

        if (sidebarToggle) {
            sidebarToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebar.classList.toggle('active');
            });
        }

        if (mainContent) {
            mainContent.addEventListener('click', () => {
                if (sidebar.classList.contains('active')) {
                    sidebar.classList.remove('active');
                }
            });
        }

        // ADB toggle buttons
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setAdbCommand(btn.dataset.adb));
        });

        // Top bar actions
        document.getElementById('btnRunAll').addEventListener('click', () => this.runAllTests());
        document.getElementById('btnRunModule').addEventListener('click', () => {
            const category = document.getElementById('moduleSelector').value;
            this.runAllTests(category);
        });
        document.getElementById('btnClearResults').addEventListener('click', () => this.showClearConfirm());
        document.getElementById('btnConfirmClear').addEventListener('click', () => this.clearResults());
        document.getElementById('btnCancelClear').addEventListener('click', () => this.closeClearConfirm());
        document.getElementById('btnExport').addEventListener('click', () => this.exportResults());
        document.getElementById('btnRefreshDevice').addEventListener('click', () => this.checkDeviceStatus(true));
        document.getElementById('btnReboot').addEventListener('click', () => this.rebootDevice());
        // document.getElementById('btnSaveResults').addEventListener('click', () => this.saveResultsToServer());

        // Model Switch Modal
        document.getElementById('btnConfirmSwitch').addEventListener('click', () => this.confirmSwitch());
        document.getElementById('btnCancelSwitch').addEventListener('click', () => this.closeSwitchModal());

        // Manage Modal
        document.getElementById('btnManage').addEventListener('click', () => {
            if (this.adminToken) {
                this.showManageModal();
            } else {
                this.showLoginModal();
            }
        });
        document.getElementById('manageModalClose').addEventListener('click', () => this.closeManageModal());
        document.getElementById('btnSaveCommand').addEventListener('click', () => this.saveNewCommand());
        document.getElementById('btnSaveModel').addEventListener('click', () => this.saveNewModel());
        document.getElementById('btnUpdateModel').addEventListener('click', () => this.updateModel());
        document.getElementById('btnUpdateCommand').addEventListener('click', () => this.updateCommand());
        document.getElementById('btnSaveCategory').addEventListener('click', () => this.saveNewCategory());
        document.getElementById('btnLogout').addEventListener('click', () => this.logout());
        document.getElementById('deviceSelector').addEventListener('change', (e) => this.handleDeviceChange(e.target.value, true));

        document.getElementById('addCmdModel').addEventListener('change', () => this.updateCategoryDropdowns('add'));
        document.getElementById('addCatModel').addEventListener('change', () => { /* Just for sync */ });

        // Module Selection Modal
        document.getElementById('moduleSelectModalClose').addEventListener('click', () => {
            document.getElementById('moduleSelectionModal').classList.remove('active');
        });
        document.getElementById('btnSelectAllModules').addEventListener('click', () => this.toggleAllModuleCheckboxes());
        document.getElementById('btnStartCustomRun').addEventListener('click', () => this.startCustomRun());

        // Edit Dropdown Logic
        document.getElementById('editCmdModelSelect').addEventListener('change', () => this.updateEditCmdList());
        document.getElementById('editCmdSelect').addEventListener('change', () => this.populateEditCmdDetails());
        document.getElementById('editModelSelect').addEventListener('change', () => this.populateEditModelDetails());

        // Login Modal
        document.getElementById('loginModalClose').addEventListener('click', () => this.closeLoginModal());
        document.getElementById('btnLoginSubmit').addEventListener('click', () => this.handleLogin());
        document.getElementById('adminPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });

        // Report
        document.getElementById('btnViewReport').addEventListener('click', () => this.showReport());
        document.getElementById('reportModalClose').addEventListener('click', () => this.closeReport());

        // Regression
        document.getElementById('btnRegression').addEventListener('click', () => this.showRegressionModal());
        document.getElementById('regressionModalClose').addEventListener('click', () => this.closeRegressionModal());
        document.getElementById('btnStartRegression').addEventListener('click', () => this.startRegression());
        document.getElementById('btnPauseRegression').addEventListener('click', () => this.toggleRegressionPause());
        document.getElementById('btnStopRegression').addEventListener('click', () => { this.stopRegression = true; });
        document.getElementById('btnAddRegStep').addEventListener('click', () => this.addRegressionStep());
        document.getElementById('btnAddRegModule').addEventListener('click', () => this.showRegModuleSelection());
        document.getElementById('btnClearRegLog').addEventListener('click', () => this.clearRegressionLog());
        document.getElementById('btnExportRegReport').addEventListener('click', () => this.exportRegressionReport());

        // External Tools
        document.getElementById('btnDltSettings').addEventListener('click', () => this.showDLTConfig());
        document.getElementById('dltConfigModalClose').addEventListener('click', () => {
            document.getElementById('dltConfigModal').classList.remove('active');
        });
        document.getElementById('btnSaveDltConfig').addEventListener('click', () => this.saveDLTConfig());

        // Manage Tabs
        document.querySelectorAll('#manageModal .tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#manageModal .tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('#manageModal .manage-form').forEach(f => f.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(btn.dataset.target).classList.add('active');

                if (btn.dataset.target === 'formRemoveItems') {
                    this.populateRemoveLists();
                }
            });
        });

        document.getElementById('removeCmdModelSelect').addEventListener('change', () => this.updateRemoveCommandList());

        // Stat cards filtering
        document.querySelector('.stat-card.stat-pass').addEventListener('click', () => this.filterByStatus('pass'));
        document.querySelector('.stat-card.stat-fail').addEventListener('click', () => this.filterByStatus('fail'));
        document.querySelector('.stat-card.stat-pending').addEventListener('click', () => this.filterByStatus('pending'));
        document.querySelector('.stat-card:not(.stat-pass):not(.stat-fail):not(.stat-pending)').addEventListener('click', () => this.filterCommands('all'));

        // Modules
        document.getElementById('btnSendSms').addEventListener('click', () => this.sendSms());
        document.getElementById('btnDial').addEventListener('click', () => this.dialNumber());
        document.getElementById('btnEndCall').addEventListener('click', () => this.endCall());
        document.getElementById('btnSetRegion').addEventListener('click', () => this.setRegion());
        document.getElementById('btnSetImei').addEventListener('click', () => this.setImei());

        // Report Column Toggles
        document.querySelectorAll('.export-options input[type="checkbox"]').forEach(box => {
            box.addEventListener('change', () => this.generateReport());
        });

        // Modal close
        document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.classList.remove('active');
                if (e.target.id === 'confirmSwitchModal') this.pendingModelSwitch = null;
            }
        });
    }

    loadFilterTabs() {
        const tabsCont = document.getElementById('filterTabs');
        tabsCont.innerHTML = '';

        // Create "All Commands" tab
        const allBtn = document.createElement('button');
        allBtn.className = `filter-tab ${this.currentFilter === 'all' ? 'active' : ''}`;
        allBtn.dataset.filter = 'all';
        allBtn.textContent = 'All Commands';
        allBtn.addEventListener('click', () => this.filterCommands('all'));
        tabsCont.appendChild(allBtn);

        const modelCategories = this.commandsData[this.currentModel].categories || [];
        modelCategories.forEach(catId => {
            const cat = this.categoriesData[catId] || { label: catId, color: "#666" };
            const btn = document.createElement('button');
            btn.className = `filter-tab ${this.currentFilter === catId ? 'active' : ''}`;
            btn.dataset.filter = catId;
            btn.textContent = cat.label;
            btn.addEventListener('click', () => this.filterCommands(catId));
            tabsCont.appendChild(btn);
        });
    }

    loadCommands() {
        const grid = document.getElementById('commandsGrid');
        grid.innerHTML = '';

        let commands = [...(this.commandsData[this.currentModel]?.commands || [])];

        // Apply category filter
        if (this.currentFilter !== 'all' && !['pass', 'fail', 'pending'].includes(this.currentFilter)) {
            commands = commands.filter(c => c.category === this.currentFilter);
        }

        // Apply status filter
        if (this.currentFilter === 'pass') {
            commands = commands.filter(c => this.results[c.id]?.success);
        } else if (this.currentFilter === 'fail') {
            commands = commands.filter(c => this.results[c.id] && !this.results[c.id].success);
        } else if (this.currentFilter === 'pending') {
            commands = commands.filter(c => !this.results[c.id]);
        }

        commands.forEach(cmd => {
            const result = this.results[cmd.id];
            const card = document.createElement('div');
            card.className = `command-card ${result ? (result.success ? 'pass' : 'fail') : ''}`;
            card.id = `card-${cmd.id}`;

            card.innerHTML = `
                <div class="command-header">
                    <span class="command-name">${cmd.name}</span>
                    <span class="command-category" style="background: ${this.categoriesData[cmd.category]?.color || '#666'}">
                        ${this.categoriesData[cmd.category]?.label || cmd.category}
                    </span>
                </div>
                <div class="command-code">${cmd.command.replace(/^adb1?\s/, this.adbCommand + ' ')}</div>
                <div class="command-actions">
                    <button class="btn-run" onclick="app.runCommand('${cmd.id}')">▶️ Run</button>
                    <button class="btn-result" onclick="app.showResult('${cmd.id}')" ${!result ? 'disabled' : ''}>📋 Result</button>
                </div>
            `;
            grid.appendChild(card);
        });

        // Add "Add Custom Test" card for admins
        if (this.adminToken) {
            const addCard = document.createElement('div');
            addCard.className = 'command-card add-new-card';
            addCard.style.border = '2px dashed var(--border-color)';
            addCard.style.background = 'rgba(255,255,255,0.02)';
            addCard.style.cursor = 'pointer';
            addCard.style.display = 'flex';
            addCard.style.flexDirection = 'column';
            addCard.style.alignItems = 'center';
            addCard.style.justifyContent = 'center';
            addCard.style.minHeight = '150px';

            const targetCat = ['all', 'pass', 'fail'].includes(this.currentFilter) ? '' : this.currentFilter;

            addCard.innerHTML = `
                <div style="font-size: 2.5rem; margin-bottom: 10px; opacity: 0.5;">➕</div>
                <div style="font-weight: 700; color: var(--text-secondary);">Add New Test</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">
                    Module: ${targetCat ? targetCat.toUpperCase() : 'Auto'}
                </div>
            `;

            addCard.addEventListener('click', () => this.showManageModal(targetCat));
            grid.appendChild(addCard);
        }

        this.updateModuleVisibility();
    }

    async runCommand(id, silent = false, overrideCommand = null) {
        // Use cached connection status - don't block with a fresh check
        if (!this.deviceConnected) {
            return this.showErrorPopup('Device Not Connected', 'No device found!\nPlease connect a device via ADB to execute commands.');
        }

        const cmd = this.commandsData[this.currentModel].commands.find(c => c.id === id);
        if (!cmd) return;

        // Check if this is a SIM-dependent command (dial, SMS, call, USSD) - but NOT eCall
        const simDependentTerms = ['dial', 'sms', 'call', 'msg', 'message', 'ussd'];
        const isECall = id.toLowerCase().includes('ecall');
        const isSimDependent = simDependentTerms.some(term => id.toLowerCase().includes(term)) && !isECall;

        if (isSimDependent && this.simState !== 5) {
            // SIM not ready - auto-fail these commands
            const card = document.getElementById(`card-${id}`);
            const runBtn = card?.querySelector('.btn-run');

            this.results[id] = {
                success: false,
                name: cmd.name,
                command: overrideCommand || cmd.command,
                output: `[SIM REQUIRED]\nThis command requires an active SIM card.\nCurrent SIM State: ${this.simState === 1 ? 'Absent' : 'Not Ready'}\n\nDial and SMS commands cannot work without a valid SIM.`
            };

            if (card) {
                card.classList.remove('pass', 'running');
                card.classList.add('fail');
                card.querySelector('.btn-result').disabled = false;
            }
            if (!silent) this.showToast('SIM Required - Command Failed', false);
            this.updateStats();
            return this.results[id];
        }

        const card = document.getElementById(`card-${id}`);
        const runBtn = card?.querySelector('.btn-run');
        if (card) { card.classList.remove('pass', 'fail'); card.classList.add('running'); }
        if (runBtn) { runBtn.innerHTML = '<span class="loading"></span>'; runBtn.disabled = true; }

        try {
            const response = await this.apiCall('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command: overrideCommand || cmd.command,
                    targetSerial: this.deviceSerial  // Pass explicit target
                })
            });
            let result = await response.json();

            // Handle specific error codes from server
            if (result.error === 'DEVICE_DISCONNECTED') {
                this.showDeviceDisconnectedPopup(result.disconnectedSerial, result.availableDevices);
                this.results[id] = {
                    success: false,
                    name: cmd.name,
                    command: cmd.command,
                    output: result.output
                };
                if (card) { card.classList.remove('running'); card.classList.add('fail'); }
                if (runBtn) { runBtn.innerHTML = '▶️ Run'; runBtn.disabled = false; }
                this.updateStats();
                return this.results[id];
            }

            if (result.error === 'MULTIPLE_DEVICES') {
                this.showErrorPopup('Multiple Devices', 'Multiple devices are connected.\n\nPlease select a specific device from the dropdown menu.');
                this.fetchDevices(); // Refresh device list
                if (card) { card.classList.remove('running'); }
                if (runBtn) { runBtn.innerHTML = '▶️ Run'; runBtn.disabled = false; }
                return { success: false, output: 'Multiple Devices Connected' };
            }

            if (result.error === 'NO_DEVICE') {
                this.showErrorPopup('No Device', 'No device connected.\n\nPlease connect a device via ADB.');
                this.deviceConnected = false;
                this.updateUIWithStatus(null);
                if (card) { card.classList.remove('running'); }
                if (runBtn) { runBtn.innerHTML = '▶️ Run'; runBtn.disabled = false; }
                return { success: false, output: 'No Device Connected' };
            }

            if (id === 'dial') {
                const targetElId = this.isRegressionRunning ? 'regStatusContent' : 'callResult';
                this.monitorCallStatus(targetElId);
            }

            // Global Validation Mapping
            const expectedPattern = cmd.expected || this.getExpectedPattern(id);
            if (expectedPattern) { // Run validation regardless of result.success initially
                const regex = new RegExp(expectedPattern, 'i');
                const isMatch = regex.test(result.output);
                if (!isMatch) {
                    result.success = false;
                    result.output = `[VALIDATION FAILED]\nExpected pattern: ${expectedPattern}\n\nActual Output:\n${result.output}`;
                }
            }

            this.results[id] = { ...result, name: cmd.name, command: cmd.command };
            if (card) {
                card.classList.remove('running');
                card.classList.add(result.success ? 'pass' : 'fail');
                card.querySelector('.btn-result').disabled = false;
            }
            if (!silent) this.showToast(result.success ? 'Success' : 'Failed', result.success);

            if (runBtn) { runBtn.innerHTML = '▶️ Run'; runBtn.disabled = false; }
            this.updateStats();
            return result;
        } catch (e) {
            console.error(e);
            let output = `Execution Error: ${e.message}`;

            this.results[id] = {
                success: false,
                name: cmd.name,
                command: cmd.command,
                output: output,
                error: true
            };
            if (card) {
                card.classList.remove('running');
                card.classList.add('fail');
                card.querySelector('.btn-result').disabled = false;
            }
            if (!silent) this.showToast('Execution Failed', false);

            if (runBtn) { runBtn.innerHTML = '▶️ Run'; runBtn.disabled = false; }
            this.updateStats();
            return this.results[id];
        }
    }

    async runAllTests(category = null) {
        // If we are triggering "Run All" or "Run Module" without the selection modal, check if we need selection
        if (!category || category === 'all') {
            this.showModuleSelectionModal();
            return;
        }

        const suite = {
            modules: [category],
            includeVerification: true // Individual module run usually includes everything
        };
        this.executeTestSuite(suite);
    }

    showModuleSelectionModal() {
        const modal = document.getElementById('moduleSelectionModal');
        const checklist = document.getElementById('moduleChecklist');
        checklist.innerHTML = '';

        const modelCategories = this.commandsData[this.currentModel].categories || [];
        modelCategories.forEach(catId => {
            const cat = this.categoriesData[catId] || { label: catId };
            const item = document.createElement('div');
            item.className = 'module-check-item';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '10px';
            item.style.padding = '8px';
            item.style.background = 'rgba(255,255,255,0.03)';
            item.style.borderRadius = '4px';

            item.innerHTML = `
                <input type="checkbox" id="check-${catId}" value="${catId}" checked style="width: 18px; height: 18px;">
                <label for="check-${catId}" style="margin: 0; cursor: pointer; flex: 1;">${cat.label}</label>
            `;
            checklist.appendChild(item);
        });

        modal.classList.add('active');
    }

    toggleAllModuleCheckboxes() {
        const checks = document.querySelectorAll('#moduleChecklist input[type="checkbox"]');
        const anyUnchecked = Array.from(checks).some(c => !c.checked);
        checks.forEach(c => c.checked = anyUnchecked);
        document.getElementById('btnSelectAllModules').textContent = anyUnchecked ? 'Deselect All' : 'Select All';
    }

    startCustomRun() {
        const checks = document.querySelectorAll('#moduleChecklist input[type="checkbox"]:checked');
        const selectedModules = Array.from(checks).map(c => c.value);
        const includeVerification = document.getElementById('includeVerificationCmds').checked;

        if (selectedModules.length === 0) return this.showToast('Select at least one module', false);

        document.getElementById('moduleSelectionModal').classList.remove('active');

        this.executeTestSuite({
            modules: selectedModules,
            includeVerification
        });
    }

    async executeTestSuite(suite) {
        let commands = this.commandsData[this.currentModel].commands;

        // Filter by selected modules
        commands = commands.filter(cmd => suite.modules.includes(cmd.category));

        // Filter by verification flag if necessary
        if (!suite.includeVerification) {
            commands = commands.filter(cmd => !cmd.excludeFromRunAll);
        }

        if (commands.length === 0) return this.showToast('No commands to run with this selection', false);

        // Update current filter UI for multi-module runs
        this.currentFilter = suite.modules.length === 1 ? suite.modules[0] : 'all';
        this.loadFilterTabs(); // Update active tab UI

        this.activeSuiteModules = suite.modules;

        // Reset state
        this.results = {};
        this.updateStats();
        this.stopExecution = false;
        this.isRunningAll = true;

        // Open Report View immediately
        this.showReport();

        const btn = document.getElementById('btnRunAll');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="loading"></span> Running...';
        btn.disabled = true;
        this.isRunningAll = true;
        this.isPaused = false;
        this.stopExecution = false;

        for (const cmd of commands) {
            // Check for Stop
            if (this.stopExecution) {
                console.log('Execution Stopped by User');
                break;
            }

            // Check for Pause
            while (this.isPaused && !this.stopExecution) {
                await new Promise(r => setTimeout(r, 500));
            }

            if (this.stopExecution) break;

            // Visually mark row as running
            const row = document.getElementById(`report-row-${cmd.id}`);
            if (row) {
                const statusCell = row.querySelector('.report-status-cell');
                if (statusCell) {
                    statusCell.className = 'report-status-cell running';
                    statusCell.textContent = 'RUNNING...';
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            // Execute command - no timeout, let it complete naturally
            await this.runCommand(cmd.id, true);

            // Update row with real result
            this.updateReportRow(cmd.id);
            this.updateReportStats(); // Update modal stats

            await new Promise(r => setTimeout(r, cmd.id === 'dial' ? 5000 : 100));
        }

        this.isRunningAll = false;
        btn.innerHTML = originalText;
        btn.disabled = false;

        // Update Stop Button state to 'Reprint' or hide
        const stopBtn = document.getElementById('reportStopBtn');
        if (stopBtn) {
            stopBtn.innerHTML = '🏁 Completed';
            stopBtn.disabled = true;
            stopBtn.style.background = 'var(--text-muted)';
        }
    }

    stopAllTests() {
        if (!this.isRunningAll) return;
        this.stopExecution = true;
        this.isPaused = false;
        const stopBtn = document.getElementById('reportStopBtn');
        if (stopBtn) {
            stopBtn.innerHTML = '🛑 Stopping...';
            stopBtn.classList.add('stopping');
            stopBtn.disabled = true;
        }
        this.showToast('Wait! Stopping execution...', false);
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        const pauseBtn = document.getElementById('reportPauseBtn');
        if (pauseBtn) {
            pauseBtn.innerHTML = this.isPaused ? '▶️ Resume' : '⏸️ Pause';
            pauseBtn.className = this.isPaused ? 'btn-success' : 'btn-warning';
        }
        this.showToast(this.isPaused ? 'Execution Paused' : 'Execution Resumed', !this.isPaused);
    }

    setupReportControls() {
        // Inject Stats and Stop Button into report header
        const controlsContainer = document.getElementById('reportControlsContainer');
        if (!controlsContainer) return;

        // Clear previous controls if any
        controlsContainer.innerHTML = '';

        // Create Stats Bar
        const statsBar = document.createElement('div');
        statsBar.id = 'reportStatsBar';
        statsBar.className = 'report-stats-bar';
        statsBar.style.justifyContent = 'center'; // Center for report header
        statsBar.innerHTML = `
            <div class="report-stat total">Total: <span id="rep-total">0</span></div>
            <div class="report-stat pass">Pass: <span id="rep-pass">0</span></div>
            <div class="report-stat fail">Fail: <span id="rep-fail">0</span></div>
            <div class="report-actions" style="display: ${this.isRunningAll ? 'flex' : 'none'}; gap: 10px;">
                <button id="reportPauseBtn" class="btn-warning">⏸️ Pause</button>
                <button id="reportStopBtn" class="btn-danger">🛑 Stop</button>
            </div>
        `;

        controlsContainer.appendChild(statsBar);

        const stopBtn = document.getElementById('reportStopBtn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopAllTests());
        }

        const pauseBtn = document.getElementById('reportPauseBtn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => this.togglePause());
        }
        this.updateReportStats();
    }

    updateReportStats() {
        const total = this.commandsData[this.currentModel].commands.length;
        const results = Object.values(this.results);
        const passed = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        const elTotal = document.getElementById('rep-total');
        if (elTotal) {
            elTotal.textContent = total;
            document.getElementById('rep-pass').textContent = passed;
            document.getElementById('rep-fail').textContent = failed;
        }

        // Keep action buttons visibility in sync with running state
        const actions = document.querySelector('.report-actions');
        if (actions) {
            actions.style.display = this.isRunningAll ? 'flex' : 'none';
        }
    }

    filterCommands(filter) {
        this.currentFilter = filter;
        document.querySelectorAll('.filter-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.filter === filter);
        });
        this.loadCommands();
        this.updateStats();
        this.updateModuleVisibility();
    }

    async loadConfig() {
        try {
            const response = await this.apiCall('/api/config');
            const data = await response.json();

            // Sync binary
            if (data.adbCommand) {
                this.adbCommand = data.adbCommand.startsWith('adb1') ? 'adb1' : 'adb';
                this.updateAdbToggleUI();
            }

            // Sync serial from server to client, or vice versa
            if (data.serial) {
                this.deviceSerial = data.serial;
                localStorage.setItem('adbSerial', data.serial);
            } else if (this.deviceSerial) {
                // If server has no serial but we have one in localStorage, sync it to server
                await this.handleDeviceChange(this.deviceSerial);
            }
        } catch (e) { console.error('Error loading config', e); }
    }

    async setAdbCommand(cmd) {
        this.adbCommand = cmd;
        this.updateAdbToggleUI();
        try {
            await this.apiCall('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adbCommand: cmd })
            });
            this.showToast(`Switched to ${cmd.toUpperCase()}`, true);

            // CRITICAL: Refresh devices and status using the new binary
            await this.fetchDevices();
            await this.checkDeviceStatus();

            this.loadCommands(); // Update the command strings in cards
        } catch (e) { this.showToast('Config update failed', false); }
    }

    updateAdbToggleUI() {
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.adb === this.adbCommand);
        });
    }

    updateStats() {
        if (!this.commandsData || !this.commandsData[this.currentModel]) return;

        const commands = this.commandsData[this.currentModel].commands;
        const total = commands.length;
        const results = Object.values(this.results);
        const passed = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        const pending = total - (passed + failed);

        const elTotal = document.getElementById('totalTests');
        const elPass = document.getElementById('passedTests');
        const elFail = document.getElementById('failedTests');
        const elPend = document.getElementById('pendingTests');

        if (elTotal) elTotal.textContent = total;
        if (elPass) elPass.textContent = passed;
        if (elFail) elFail.textContent = failed;
        if (elPend) elPend.textContent = pending;
    }

    showResult(id) {
        const result = this.results[id];
        const cmd = this.commandsData[this.currentModel].commands.find(c => c.id === id);
        if (!result || !cmd) return;

        document.getElementById('modalTitle').textContent = `Result: ${cmd.name}`;
        document.getElementById('modalCommand').textContent = result.command;
        document.getElementById('modalOutput').textContent = result.output;

        const statusBadge = document.querySelector('#resultModal .status-badge');
        statusBadge.textContent = result.success ? 'PASS' : 'FAIL';
        statusBadge.className = `status-badge ${result.success ? 'pass' : 'fail'}`;

        document.getElementById('resultModal').classList.add('active');
    }

    filterByStatus(status) {
        this.currentFilter = status;
        this.loadCommands();
    }

    async fetchDevices() {
        try {
            const response = await this.apiCall('/api/devices');
            const data = await response.json();
            if (data.success) {
                const selector = document.getElementById('deviceSelector');
                selector.innerHTML = '';

                if (data.devices.length === 0) {
                    selector.innerHTML = '<option value="" disabled selected>No devices found</option>';
                    this.deviceSerial = '';
                    localStorage.removeItem('adbSerial');
                    return;
                }

                // Get list of ready device IDs
                const readyDevices = data.devices.filter(d => d.status.toLowerCase() === 'device');
                const readyIds = readyDevices.map(d => d.id.toLowerCase());

                data.devices.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.id;
                    opt.textContent = `${d.id} (${d.status})`;
                    selector.appendChild(opt);
                });

                // Check if saved serial is still valid
                const savedSerial = (this.deviceSerial || '').toLowerCase();
                const isValidSaved = savedSerial && readyIds.includes(savedSerial);

                if (isValidSaved) {
                    // Saved serial is valid - use it
                    const match = data.devices.find(d => d.id.toLowerCase() === savedSerial);
                    selector.value = match.id;
                    this.deviceSerial = match.id; // Use exact case from ADB
                } else if (readyDevices.length > 0) {
                    // Saved serial is invalid or missing - use first available device
                    const firstDevice = readyDevices[0].id;
                    selector.value = firstDevice;
                    this.deviceSerial = firstDevice;
                    localStorage.setItem('adbSerial', firstDevice);

                    // Sync with server
                    await this.apiCall('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ serial: firstDevice })
                    });

                    console.log(`[DEVICE] Auto-selected: ${firstDevice}`);
                }
            }
        } catch (e) { console.error('Error fetching devices', e); }
    }

    async handleDeviceChange(serial, isUserInitiated = false) {
        // Confirmation Logic for Switching Devices
        if (isUserInitiated && this.deviceConnected && this.deviceSerial && serial !== this.deviceSerial) {
            const confirmed = confirm(`Are you sure you want to switch the device from ${this.deviceSerial} to ${serial}?\n\nAll your current results will be erased.`);
            if (!confirmed) {
                // Revert selection
                document.getElementById('deviceSelector').value = this.deviceSerial;
                return;
            }
            // User confirmed: clear results
            this.clearResults();
        }

        this.deviceSerial = serial;
        localStorage.setItem('adbSerial', serial);
        try {
            await this.apiCall('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serial })
            });

            // Only show toast if user specifically initiated the change.
            // Suppress the "Targeting Auto Detect" or generic toasts on load.
            if (isUserInitiated) {
                this.showToast(`Selected: ${serial || 'No device'}`, true, 1500);
            }

            // AUTO-LAUNCH DLT FORWARDING
            if (this.deviceConnected) {
                this.launchDLT();
            }

            this.checkDeviceStatus(); // Trigger immediate refresh
        } catch (e) {
            this.showToast('Config update failed', false);
        }
    }

    async checkDeviceStatus(force = false) {
        if (this.isRunningAll || this.isRegressionRunning) return;

        const refreshBtn = document.getElementById('btnRefreshDevice');
        const originalBtnHtml = refreshBtn ? refreshBtn.innerHTML : '';

        if (force && refreshBtn) {
            refreshBtn.innerHTML = '<span class="loading"></span> Refreshing...';
            refreshBtn.disabled = true;
        }

        try {
            const response = await this.apiCall(`/api/device-status?t=${Date.now()}`);
            const data = await response.json();

            // Detected disconnection state transition
            if (this.deviceConnected && !data.connected) {
                // If we detect a disconnection, immediately try to refresh the device list 
                // to see if a new device appeared (swap scenario) or to clear invalid option
                this.fetchDevices();
            }

            // Only update if something actually changed (bypass if force-refresh)
            const newStatus = JSON.stringify(data);
            if (!force && this.lastStatusCache === newStatus) return;
            this.lastStatusCache = newStatus;

            this.deviceConnected = data.connected;
            this.simState = data.extraInfo ? data.extraInfo.simState : -1;
            this.updateUIWithStatus(data);
        } catch (e) {
            // Only show popups for connection errors if we previously thought we were connected
            if (this.deviceConnected && this.deviceSerial) {
                this.deviceConnected = false;
                this.fetchDevices(); // Try to refresh list
            }
            this.updateUIWithStatus(null);
        } finally {
            if (force && refreshBtn) {
                refreshBtn.innerHTML = originalBtnHtml;
                refreshBtn.disabled = false;
            }
        }
    }

    updateUIWithStatus(data) {
        const statusCard = document.getElementById('deviceStatusCard');
        const statusText = document.getElementById('deviceStatusText');
        const connStatus = document.getElementById('connectionStatus');
        const dot = connStatus.querySelector('.status-dot');
        const text = connStatus.querySelector('.status-text');

        if (data && data.connected) {
            statusCard.classList.add('connected');
            statusCard.classList.remove('disconnected');
            statusText.textContent = `Connected (${data.deviceCount} device)`;
            dot.style.background = 'var(--success)';
            text.textContent = 'Connected';



            if (data.extraInfo) {
                document.getElementById('deviceIdDisplay').textContent = data.extraInfo.imei || '-';
                document.getElementById('serviceStateDisplay').textContent = data.extraInfo.serviceState || '-';

                const fullRegion = (data.extraInfo.region || '').toUpperCase();
                document.getElementById('regionDisplay').textContent = fullRegion || '-';

                // 1. Extract the text code (e.g., "IN" from "IN (9)")
                const regionCode = fullRegion.split(' ')[0].trim();

                // 2. Extract numeric nation (e.g., "9" from "IN (9)")
                const nationMatch = fullRegion.match(/\((\d+)\)/);
                const nationIndex = nationMatch ? nationMatch[1] : null;

                // Update Software Version
                document.getElementById('swVersionDisplay').textContent = data.extraInfo.swVersion || '-';

                // Update Flag/Globe Icon
                const regionIcon = document.getElementById('regionIcon');

                // Mapping alphabetic codes to ISO country codes
                const isoMap = {
                    'IN': 'in', 'IND': 'in',
                    'AE': 'ae', 'ARE': 'ae',
                    'SA': 'sa', 'SAU': 'sa',
                    'JP': 'jp', 'JPN': 'jp',
                    'KR': 'kr', 'KOR': 'kr',
                    'TW': 'tw', 'TWN': 'tw',
                    'TH': 'th', 'THA': 'th',
                    'MY': 'my', 'MYS': 'my',
                    'ID': 'id', 'IDN': 'id',
                    'PH': 'ph', 'PHL': 'ph',
                    'SG': 'sg', 'SGP': 'sg',
                    'BH': 'bh', 'BHR': 'bh',
                    'QA': 'qa', 'QAT': 'qa',
                    'KW': 'kw', 'KWT': 'kw',
                    'ZA': 'za', 'ZAF': 'za',
                    'VN': 'vn', 'VNM': 'vn',
                    'GB': 'gb', 'UK': 'gb',
                    'US': 'us', 'USA': 'us'
                };

                // Detailed Nation Index Mapping (Fallback)
                const indexToIso = {
                    '1': 'jp', '64': 'jp', '65': 'jp',
                    '9': 'ae', '72': 'ae', '73': 'ae', '41': 'ae', '104': 'ae', '105': 'ae',
                    '11': 'sa', '74': 'sa', '75': 'sa', '43': 'sa', '106': 'sa', '107': 'sa',
                    '13': 'in', '76': 'in', '77': 'in',
                    '17': 'kr', '80': 'kr', '81': 'kr',
                    '19': 'tw', '82': 'tw', '83': 'tw',
                    '21': 'th', '84': 'th', '85': 'th',
                    '23': 'my', '86': 'my', '87': 'my',
                    '25': 'id', '88': 'id', '89': 'id',
                    '27': 'ph', '90': 'ph', '91': 'ph',
                    '29': 'sg', '92': 'sg', '93': 'sg',
                    '35': 'bh', '98': 'bh', '99': 'bh',
                    '37': 'qa', '100': 'qa', '101': 'qa',
                    '39': 'kw', '102': 'kw', '103': 'kw',
                    '31': 'za', '94': 'za', '95': 'za',
                    '33': 'vn', '96': 'vn', '97': 'vn'
                };

                let finalIso = isoMap[regionCode] || indexToIso[nationIndex];

                if (finalIso) {
                    regionIcon.innerHTML = `<img src="https://flagcdn.com/w80/${finalIso}.png" alt="Flag">`;
                } else {
                    regionIcon.textContent = '🌍';
                }

                document.getElementById('radioStatusDisplay').textContent = data.extraInfo.radioOn ? 'ON' : 'OFF';
                document.getElementById('simStatusDisplay').textContent = data.extraInfo.simStateText || 'Unknown';

                document.getElementById('serviceStateCard').classList.toggle('pass', data.extraInfo.isServicePass);
                document.getElementById('serviceStateCard').classList.toggle('fail', !data.extraInfo.isServicePass);
                document.getElementById('radioStateCard').classList.toggle('pass', data.extraInfo.radioOn);
                document.getElementById('radioStateCard').classList.toggle('fail', !data.extraInfo.radioOn);

                const isSimOk = data.extraInfo.simState === 5;
                document.getElementById('simStateCard').classList.toggle('pass', isSimOk);
                document.getElementById('simStateCard').classList.toggle('fail', !isSimOk);
            }
        } else {
            statusCard.classList.remove('connected');
            statusCard.classList.add('disconnected');
            statusText.textContent = 'No Device Connected';
            dot.style.background = 'var(--error)';
            text.textContent = 'Disconnected';

            ['deviceIdDisplay', 'serviceStateDisplay', 'regionDisplay', 'radioStatusDisplay', 'simStatusDisplay'].forEach(id => {
                document.getElementById(id).textContent = '-';
            });
            document.getElementById('regionIcon').textContent = '🌍';
            document.querySelectorAll('.device-status-card').forEach(c => c.classList.remove('pass', 'fail'));
        }
    }

    showLoginModal() {
        document.getElementById('loginModal').classList.add('active');
        document.getElementById('adminUsername').focus();
    }

    closeLoginModal() {
        document.getElementById('loginModal').classList.remove('active');
    }

    async handleLogin() {
        const username = document.getElementById('adminUsername').value;
        const password = document.getElementById('adminPassword').value;

        if (!username || !password) return this.showToast('Enter username and password', false);

        try {
            const response = await this.apiCall('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const data = await response.json();
                if (data.success) {
                    this.adminToken = data.token;
                    this.adminUser = data.username;
                    localStorage.setItem('adminToken', data.token);
                    localStorage.setItem('adminUser', data.username);
                    this.showToast(`Logged in as ${data.username}`, true);
                    this.closeLoginModal();
                    this.updateAdminUI(); // Update UI status
                    this.showManageModal();
                } else {
                    this.showToast(data.error || 'Login failed', false);
                }
            } else {
                console.error('Non-JSON response:', await response.text());
                this.showToast('Server error: Please restart server.js and refresh page', false);
            }
        } catch (e) {
            console.error('Login error:', e);
            this.showToast('Connection error: ' + e.message, false);
        }
    }

    logout() {
        this.adminToken = null;
        this.adminUser = null;
        localStorage.removeItem('adminToken');
        localStorage.removeItem('adminUser');
        this.updateAdminUI();
        this.closeManageModal();
        this.showToast('Logged out successfully', true);
    }

    updateAdminUI() {
        const statusDiv = document.getElementById('adminStatus');
        const userDisplay = document.getElementById('adminUserDisplayName');
        const addButtons = document.querySelectorAll('.btn-icon-add');

        if (this.adminToken && this.adminUser) {
            if (statusDiv) statusDiv.style.display = 'flex';
            if (statusDiv) statusDiv.style.alignItems = 'center';
            if (userDisplay) userDisplay.textContent = this.adminUser;
            addButtons.forEach(btn => btn.style.display = 'flex');
        } else {
            if (statusDiv) statusDiv.style.display = 'none';
            addButtons.forEach(btn => btn.style.display = 'none');
        }
    }

    showManageModal(targetCategory = null) {
        if (!this.adminToken) return this.showLoginModal();

        this.updateAdminUI();
        const addSelect = document.getElementById('addCmdModel');
        const addCatSelect = document.getElementById('addCatModel');
        const removeSelect = document.getElementById('removeCmdModelSelect');
        const editModelSelect = document.getElementById('editModelSelect');
        const editCmdModelSelect = document.getElementById('editCmdModelSelect');

        [addSelect, addCatSelect, removeSelect, editModelSelect, editCmdModelSelect].forEach(s => s.innerHTML = '');

        Object.entries(this.commandsData).forEach(([id, model]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = model.name;
            addSelect.appendChild(opt.cloneNode(true));
            addCatSelect.appendChild(opt.cloneNode(true));
            removeSelect.appendChild(opt.cloneNode(true));
            editModelSelect.appendChild(opt.cloneNode(true));
            editCmdModelSelect.appendChild(opt);
        });

        // Set current model as default in dropdowns
        addSelect.value = this.currentModel;
        addCatSelect.value = this.currentModel;
        editCmdModelSelect.value = this.currentModel;

        this.updateCategoryDropdowns('add');
        this.updateCategoryDropdowns('edit');

        // If a specific category was requested (e.g. from a "Quick Add" button)
        if (targetCategory) {
            const catSelect = document.getElementById('addCmdCategory');
            if (catSelect) catSelect.value = targetCategory;

            // Switch to the "Add Command" tab if not already there
            document.querySelectorAll('#manageModal .tab-btn').forEach(btn => {
                if (btn.dataset.target === 'formAddCommand') btn.click();
            });
        }

        this.updateEditCmdList();
        this.populateEditModelDetails();
        this.populateRemoveLists();
        document.getElementById('manageModal').classList.add('active');
    }

    updateCategoryDropdowns(type) {
        const modelId = type === 'add' ? document.getElementById('addCmdModel').value : document.getElementById('editCmdModelSelect').value;
        const catSelect = type === 'add' ? document.getElementById('addCmdCategory') : document.getElementById('editCmdCategory');

        if (!catSelect || !this.commandsData[modelId]) return;

        catSelect.innerHTML = '';
        const modelCategories = this.commandsData[modelId].categories || [];

        modelCategories.forEach(catId => {
            const cat = this.categoriesData[catId] || { label: catId };
            const opt = document.createElement('option');
            opt.value = catId;
            opt.textContent = cat.label;
            catSelect.appendChild(opt);
        });
    }

    updateEditCmdList() {
        const modelId = document.getElementById('editCmdModelSelect').value;
        this.updateCategoryDropdowns('edit');
        const cmdSelect = document.getElementById('editCmdSelect');
        cmdSelect.innerHTML = '';

        if (!modelId || !this.commandsData[modelId]) return;

        this.commandsData[modelId].commands.forEach(cmd => {
            const opt = document.createElement('option');
            opt.value = cmd.id;
            opt.textContent = cmd.name;
            cmdSelect.appendChild(opt);
        });
        this.populateEditCmdDetails();
    }

    populateEditCmdDetails() {
        const modelId = document.getElementById('editCmdModelSelect').value;
        const cmdId = document.getElementById('editCmdSelect').value;
        if (!modelId || !cmdId) return;

        const cmd = this.commandsData[modelId].commands.find(c => c.id === cmdId);
        if (cmd) {
            document.getElementById('editCmdNameInput').value = cmd.name;
            document.getElementById('editCmdValueInput').value = cmd.command;
            document.getElementById('editCmdCategory').value = cmd.category || '';
            document.getElementById('editCmdExpectedInput').value = cmd.expected || '';
            document.getElementById('editCmdExclude').checked = !!cmd.excludeFromRunAll;
        }
    }

    populateEditModelDetails() {
        const modelId = document.getElementById('editModelSelect').value;
        if (modelId && this.commandsData[modelId]) {
            document.getElementById('editModelNameInput').value = this.commandsData[modelId].name;
        }
    }

    async updateModel() {
        const id = document.getElementById('editModelSelect').value;
        const name = document.getElementById('editModelNameInput').value;
        if (!name) return this.showToast('Name cannot be empty', false);

        try {
            const response = await fetch(`/api/models/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.adminToken
                },
                body: JSON.stringify({ name })
            });

            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            if (response.ok) {
                await this.loadAllStaticData();
                this.renderModels();
                this.showToast('Model updated', true);
            }
        } catch (e) { this.showToast('Update failed', false); }
    }

    async updateCommand() {
        const modelId = document.getElementById('editCmdModelSelect').value;
        const cmdId = document.getElementById('editCmdSelect').value;
        const name = document.getElementById('editCmdNameInput').value;
        const command = document.getElementById('editCmdValueInput').value;
        const category = document.getElementById('editCmdCategory').value;
        const expected = document.getElementById('editCmdExpectedInput').value;
        const excludeFromRunAll = document.getElementById('editCmdExclude').checked;

        try {
            const response = await fetch(`/api/commands/${encodeURIComponent(modelId)}/${encodeURIComponent(cmdId)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.adminToken
                },
                body: JSON.stringify({ name, command, category, expected, excludeFromRunAll })
            });

            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            if (response.ok) {
                await this.loadAllStaticData();
                this.loadCommands();
                this.showToast('Command updated', true);
            }
        } catch (e) { this.showToast('Update failed', false); }
    }

    closeManageModal() { document.getElementById('manageModal').classList.remove('active'); }

    async saveNewCommand() {
        const modelId = document.getElementById('addCmdModel').value;
        const name = document.getElementById('addCmdName').value;
        const command = document.getElementById('addCmdValue').value;
        const category = document.getElementById('addCmdCategory').value;
        const expected = document.getElementById('addCmdExpected').value;
        const excludeFromRunAll = document.getElementById('addCmdExclude').checked;

        if (!name || !command) return this.showToast('Please fill all fields', false);

        try {
            const response = await fetch('/api/commands', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.adminToken
                },
                body: JSON.stringify({ modelId, name, command, category, expected, excludeFromRunAll })
            });

            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            if (response.ok) {
                await this.loadAllStaticData();
                this.loadCommands();
                this.loadFilterTabs();
                this.showToast('Command added successfully', true);
                this.closeManageModal();
            }
        } catch (e) { this.showToast('Error saving command', false); }
    }

    async saveNewCategory() {
        const modelId = document.getElementById('addCatModel').value;
        const categoryId = document.getElementById('newCatId').value;
        const label = document.getElementById('newCatLabel').value;
        const color = document.getElementById('newCatColor').value;

        if (!categoryId || !label) return this.showToast('Please fill all fields', false);

        try {
            const response = await this.apiCall(`/api/models/${encodeURIComponent(modelId)}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categoryId, label, color })
            });

            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            if (response.ok) {
                await this.loadAllStaticData();
                this.updateCategoryDropdowns('add');
                this.showToast('Module added successfully', true);
                // Clear fields
                document.getElementById('newCatId').value = '';
                document.getElementById('newCatLabel').value = '';
            }
        } catch (e) { this.showToast('Error saving module', false); }
    }

    async saveNewModel() {
        const name = document.getElementById('newModelNameInput').value;
        const id = document.getElementById('newModelIdInput').value;

        if (!name || !id) return this.showToast('Please fill all fields', false);

        try {
            const response = await fetch('/api/models', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.adminToken
                },
                body: JSON.stringify({ id, name })
            });

            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            if (response.ok) {
                await this.loadAllStaticData();
                this.renderModels();
                this.showToast('Model created successfully', true);
                this.closeManageModal();
            }
        } catch (e) { this.showToast('Error creating model', false); }
    }

    populateRemoveLists() {
        const modelList = document.getElementById('removeModelList');
        modelList.innerHTML = '';

        Object.entries(this.commandsData).forEach(([id, model]) => {
            const item = document.createElement('div');
            item.className = 'remove-item';
            item.innerHTML = `
                <span class="item-info">${model.name} (${id})</span>
                <button class="btn-remove" onclick="window.app.removeModel('${id}')">Delete</button>
            `;
            modelList.appendChild(item);
        });

        this.updateRemoveCommandList();
    }

    updateRemoveCommandList() {
        const modelId = document.getElementById('removeCmdModelSelect').value;
        const cmdList = document.getElementById('removeCommandList');
        cmdList.innerHTML = '';

        if (!modelId || !this.commandsData[modelId]) return;

        this.commandsData[modelId].commands.forEach(cmd => {
            const item = document.createElement('div');
            item.className = 'remove-item';
            item.innerHTML = `
                <span class="item-info">${cmd.name}</span>
                <button class="btn-remove" onclick="window.app.removeCommand('${modelId}', '${cmd.id}')">Delete</button>
            `;
            cmdList.appendChild(item);
        });
    }

    async removeModel(id) {
        if (!confirm(`Are you sure you want to delete model "${id}"? All tests within it will be lost.`)) return;

        try {
            const response = await this.apiCall(`/api/models/${encodeURIComponent(id)}`, {
                method: 'DELETE'
            });
            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }

            const data = await response.json();

            if (response.ok && data.success) {
                this.showToast('Model removed successfully', true);
                if (this.currentModel === id) {
                    this.currentModel = 'toyota'; // Fallback to toyota
                }
                await this.loadAllStaticData();
                this.renderModels();
                this.showManageModal();
                this.loadCommands(); // Reload current view
            } else {
                this.showToast(`Failed: ${data.error || 'Server error'}`, false);
            }
        } catch (e) {
            console.error('Removal error:', e);
            this.showToast('Failed to remove model', false);
        }
    }

    async removeCommand(modelId, commandId) {
        if (!confirm('Are you sure you want to delete this test case?')) return;

        try {
            const response = await this.apiCall(`/api/commands/${encodeURIComponent(modelId)}/${encodeURIComponent(commandId)}`, {
                method: 'DELETE'
            });
            if (response.status === 401) {
                this.showToast('Session expired. Please log in again.', false);
                return this.logout();
            }
            const data = await response.json();

            if (response.ok && data.success) {
                this.showToast('Test case removed', true);
                await this.loadAllStaticData();
                this.updateRemoveCommandList();
                this.loadCommands(); // Reload current view
            } else {
                this.showToast(`Failed: ${data.error || 'Server error'}`, false);
            }
        } catch (e) { this.showToast('Error removing command', false); }
    }

    async monitorCallStatus(resultElId) {
        const resultEl = document.getElementById(resultElId);
        if (!resultEl) return;

        // Clear any existing monitor
        if (this.activeCallMonitor) {
            clearInterval(this.activeCallMonitor);
            this.activeCallMonitor = null;
        }

        let wasActive = false;
        let attempts = 0;

        // Reset UI if it's regression
        if (resultElId === 'regStatusContent') {
            resultEl.innerHTML = `
                <div class="call-flow-tracker" style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                    <div id="reg-dial" class="flow-point" style="flex:1; padding: 10px; text-align: center; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-muted);">DIAL</div>
                    <div style="color: var(--text-muted);">➔</div>
                    <div id="reg-dialing" class="flow-point" style="flex:1; padding: 10px; text-align: center; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-muted);">DIALING</div>
                    <div style="color: var(--text-muted);">➔</div>
                    <div id="reg-ringing" class="flow-point" style="flex:1; padding: 10px; text-align: center; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-muted);">RINGING</div>
                    <div style="color: var(--text-muted);">➔</div>
                    <div id="reg-active" class="flow-point" style="flex:1; padding: 10px; text-align: center; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-muted);">ACTIVE</div>
                    <div style="color: var(--text-muted);">➔</div>
                    <div id="reg-end" class="flow-point" style="flex:1; padding: 10px; text-align: center; border-radius: 8px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-muted);">END</div>
                </div>
            `;
            document.getElementById('reg-dial').style.background = 'var(--accent-primary)';
            document.getElementById('reg-dial').style.color = 'white';
        }

        const updatePoint = (id, active, color) => {
            const el = document.getElementById(`reg-${id}`);
            if (el) {
                el.style.background = active ? color : 'rgba(255,255,255,0.05)';
                el.style.color = active ? 'white' : 'var(--text-muted)';
                el.style.borderColor = active ? color : 'var(--border-color)';
                if (active) el.style.boxShadow = `0 0 15px ${color}`;
                else el.style.boxShadow = 'none';
            }
        };

        const checkStatus = async () => {
            try {
                const response = await this.apiCall('/api/execute', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: 'shell sldd telephony getCallState' })
                });
                const data = await response.json();
                const output = (data.output || '').toLowerCase();

                let statusText = 'IDLE';
                let statusColor = 'var(--text-muted)';
                let statusIcon = '📵';

                if (output.includes('dialing')) {
                    statusText = 'DIALING';
                    statusColor = 'var(--warning)';
                    statusIcon = '📞';
                    if (resultElId === 'regStatusContent') updatePoint('dialing', true, 'var(--warning)');
                } else if (output.includes('alerting')) {
                    statusText = 'RINGING';
                    statusColor = 'var(--accent-primary)';
                    statusIcon = '🔔';
                    if (resultElId === 'regStatusContent') updatePoint('ringing', true, 'var(--accent-primary)');
                } else if (output.includes('active')) {
                    statusText = 'ACTIVE';
                    statusColor = 'var(--success)';
                    statusIcon = '🟢';
                    wasActive = true;
                    if (resultElId === 'regStatusContent') updatePoint('active', true, 'var(--success)');
                } else if (output.includes('offhook')) {
                    statusText = 'OFFHOOK';
                    statusColor = 'var(--accent)';
                    statusIcon = '📱';
                    wasActive = true;
                } else if (output.includes('idle') || (wasActive && !output.includes('active'))) {
                    // Explicitly handle IDLE or transition from Active -> Not Active
                    statusText = 'DISCONNECTED';
                    statusColor = 'var(--error)';
                    statusIcon = '📵';
                    if (resultElId === 'regStatusContent') updatePoint('end', true, 'var(--error)');
                }

                if (resultElId !== 'regStatusContent') {
                    resultEl.innerHTML = `<div class="result-box" style="padding: 15px; border-left: 4px solid ${statusColor}; background: rgba(0,0,0,0.3);">
                        <div style="font-weight: 700; margin-bottom: 5px;">${statusIcon} Call Status</div>
                        <div style="font-size: 1.3rem; margin: 10px 0;"><strong style="color: ${statusColor}; text-shadow: 0 0 10px ${statusColor};">${statusText}</strong></div>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">Last Update: ${new Date().toLocaleTimeString()}</div>
                    </div>`;
                }

                // Stop monitoring if disconnected or explicitly idle detected
                if (statusText === 'DISCONNECTED') {
                    if (this.activeCallMonitor) {
                        clearInterval(this.activeCallMonitor);
                        this.activeCallMonitor = null;
                    }
                    return;
                }

                attempts++;
                if (attempts > 60 || this.stopExecution || this.stopRegression) { // Stop after ~90 seconds
                    if (this.activeCallMonitor) {
                        clearInterval(this.activeCallMonitor);
                        this.activeCallMonitor = null;
                    }
                }
            } catch (e) { }
        };

        // Start immediate check, then poll every 1.5 seconds
        checkStatus();
        this.activeCallMonitor = setInterval(checkStatus, 1500);
    }


    async sendSms() {
        const phoneNumber = document.getElementById('smsPhoneNumber').value;
        const message = document.getElementById('smsMessage').value;
        const resultEl = document.getElementById('smsResult');
        if (!phoneNumber || !message) return this.showToast('Please fill all fields', false);

        // Check SIM availability first
        if (this.simState !== 5) {
            if (resultEl) {
                resultEl.innerHTML = '<div class="result-box fail" style="border-left: 4px solid var(--error);">❌ <strong>Insert SIM card</strong><br><span style="font-size: 0.85rem; color: var(--text-muted);">SIM is not ready. Please insert a valid SIM to send SMS.</span></div>';
                resultEl.classList.add('show');
            }
            this.showToast('SIM not available', false);
            return;
        }

        if (resultEl) {
            resultEl.innerHTML = '<span class="loading"></span> Sending SMS...';
            resultEl.classList.add('show');
        }

        try {
            const cmd = `shell sldd telephony sendSms16 ${phoneNumber} "${message}"`;
            const response = await this.apiCall('/api/execute', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
            });
            const result = await response.json();

            if (resultEl) {
                resultEl.innerHTML = `<div class="result-box ${result.success ? 'pass' : 'fail'}">${result.output}</div>`;
                resultEl.classList.add('show');
            }
            this.showToast(result.success ? 'SMS Sent successfully' : 'Failed to send SMS', result.success);
        } catch (e) {
            if (resultEl) resultEl.innerHTML = '<div class="result-box fail">Error sending SMS</div>';
            this.showToast('Error', false);
        }
    }

    async dialNumber() {
        const phoneNumber = document.getElementById('dialPhoneNumber').value;
        const resultEl = document.getElementById('callResult');
        if (!phoneNumber) return this.showToast('Enter number', false);

        // Check SIM availability first
        if (this.simState !== 5) {
            if (resultEl) {
                resultEl.innerHTML = '<div class="result-box fail" style="border-left: 4px solid var(--error);">❌ <strong>Insert SIM card</strong><br><span style="font-size: 0.85rem; color: var(--text-muted);">SIM is not ready. Please insert a valid SIM to make calls.</span></div>';
                resultEl.classList.add('show');
            }
            this.showToast('SIM not available', false);
            return;
        }

        if (resultEl) {
            resultEl.innerHTML = `<span class="loading"></span> Dialing ${phoneNumber}...`;
            resultEl.classList.add('show');
        }

        try {
            const response = await this.apiCall('/api/execute', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: `shell sldd telephony dial ${phoneNumber}` })
            });
            const result = await response.json();
            if (result.success) {
                if (resultEl) resultEl.classList.add('show');
                this.monitorCallStatus('callResult');
            } else {
                if (resultEl) {
                    resultEl.innerHTML = `<div class="result-box fail">Dial Failed: ${result.output}</div>`;
                    resultEl.classList.add('show');
                }
            }
        } catch (e) {
            if (resultEl) resultEl.innerHTML = '<div class="result-box fail">Error initiating call</div>';
        }
    }

    async endCall() {
        const resultEl = document.getElementById('callResult');

        // Stop any active call monitor
        if (this.activeCallMonitor) {
            clearInterval(this.activeCallMonitor);
            this.activeCallMonitor = null;
        }

        try {
            await this.apiCall('/api/execute', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'shell sldd telephony endCall' })
            });
            this.showToast('Call ended', true);
            if (resultEl) {
                resultEl.innerHTML = `<div class="result-box" style="padding: 15px; border-left: 4px solid var(--error); background: rgba(0,0,0,0.3);">
                    <div style="font-weight: 700; margin-bottom: 5px;">📵 Call Status</div>
                    <div style="font-size: 1.3rem; margin: 10px 0;"><strong style="color: var(--error); text-shadow: 0 0 10px var(--error);">DISCONNECTED</strong></div>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">Ended at: ${new Date().toLocaleTimeString()}</div>
                </div>`;
                resultEl.classList.add('show');
            }
        } catch (e) { }
    }

    async setImei() {
        const imei = document.getElementById('targetImei').value;
        const resultEl = document.getElementById('imeiResult');
        if (!imei || imei.length < 14) return this.showToast('Enter valid IMEI', false);

        if (!this.deviceConnected) {
            if (resultEl) {
                resultEl.innerHTML = '<div class="result-box fail">Device not connected</div>';
                resultEl.classList.add('show');
            }
            return this.showToast('Device not connected', false);
        }

        if (resultEl) {
            resultEl.innerHTML = '<span class="loading"></span> Writing IMEI...';
            resultEl.classList.add('show');
        }

        try {
            // Using /api/execute for exact command control as requested by user
            const response = await this.apiCall('/api/execute', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: `shell sldd telephony factorySetimei ${imei}` })
            });
            const result = await response.json();
            if (resultEl) {
                resultEl.innerHTML = `<div class="result-box ${result.success ? 'pass' : 'fail'}">${result.output}</div>`;
                resultEl.classList.add('show');
            }
            this.showToast(result.success ? 'IMEI Write Successful' : 'Failed to write IMEI', result.success);
        } catch (e) {
            if (resultEl) resultEl.innerHTML = '<div class="result-box fail">Error writing IMEI</div>';
        }
    }

    async setRegion() {
        const region = document.getElementById('regionNumber').value;
        const resultEl = document.getElementById('regionResult');
        if (!region) return this.showToast('Enter region', false);

        if (resultEl) {
            resultEl.innerHTML = `<span class="loading"></span> Setting Region to ${region}...`;
            resultEl.classList.add('show');
        }

        try {
            const response = await this.apiCall('/api/set-region', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ regionNumber: region })
            });
            const result = await response.json();
            if (resultEl) {
                resultEl.innerHTML = `<div class="result-box ${result.success ? 'pass' : 'fail'}">${result.output}</div>`;
                resultEl.classList.add('show');
            }
            this.showToast(result.success ? 'Region Set Successful' : 'Failed to set Region', result.success);
        } catch (e) {
            if (resultEl) resultEl.innerHTML = '<div class="result-box fail">Error setting region</div>';
        }
    }

    async rebootDevice() {
        if (!confirm('Reboot device?')) return;
        try {
            await this.apiCall('/api/reboot', { method: 'POST' });
            this.showToast('Rebooting...', true);
        } catch (e) { }
    }

    async exportResults() {
        const modelData = this.commandsData[this.currentModel];
        if (Object.keys(this.results).length === 0) return this.showToast('No results to export', false);

        const enabledCols = {
            sno: document.querySelector('[data-col="sno"]').checked,
            feature: document.querySelector('[data-col="feature"]').checked,
            actions: document.querySelector('[data-col="actions"]').checked,
            commands: document.querySelector('[data-col="commands"]').checked,
            output: document.querySelector('[data-col="output"]').checked,
            expected: document.querySelector('[data-col="expected"]').checked,
            result: document.querySelector('[data-col="result"]').checked
        };

        const colHeaders = {
            sno: 'S.No',
            feature: 'Feature',
            actions: 'Actions',
            commands: 'Commands',
            output: 'Actual Output',
            expected: 'Expected Output',
            result: 'Result'
        };

        const activeCols = Object.keys(enabledCols).filter(k => enabledCols[k]);
        const colCount = activeCols.length;
        if (colCount === 0) return this.showToast('Select at least one column to export', false);

        let tableHtml = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <meta charset="UTF-8">
                <style>
                    table { border-collapse: collapse; font-family: Calibri, sans-serif; }
                    th { background-color: #4472c4; color: white; border: 1pt solid black; font-weight: bold; text-align: center; padding: 5px; }
                    td { border: 1pt solid black; vertical-align: top; padding: 5px; }
                    .cat-header { background-color: #d9d9d9; color: black; font-weight: bold; text-align: center; }
                    .pass { color: #006100; font-weight: bold; text-align: center; }
                    .fail { color: #9c0006; font-weight: bold; text-align: center; }
                    pre { margin: 0; font-family: Consolas, monospace; white-space: pre-wrap; font-size: 9pt; }
                </style>
            </head>
            <body>
                <table>
                    <tr>
                        <th colspan="${colCount}" style="background: #1e293b; color: white; font-size: 16pt; height: 35pt; border: 1pt solid black; text-align: center;">TELEPHONY SANITY REPORT: ${modelData.name.toUpperCase()}</th>
                    </tr>
                    <tr>
                        <th colspan="${colCount}" style="background: #334155; color: white; font-size: 10pt; height: 20pt; border: 1pt solid black; text-align: center;">
                            Date: ${new Date().toLocaleString()} | 
                            SW: ${document.getElementById('swVersionDisplay').textContent} | 
                            Region: ${document.getElementById('regionDisplay').textContent} | 
                            IMEI: ${document.getElementById('deviceIdDisplay').textContent}
                        </th>
                    </tr>
                    <thead>
                        <tr>
                            ${activeCols.map(k => `<th style="width: ${k === 'commands' || k === 'output' || k === 'expected' ? '250pt' : '80pt'};">${colHeaders[k]}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
        `;

        let categoriesToExport = this.activeSuiteModules || modelData.categories;

        // If a specific module is selected AND we are not in the middle of a "Run All" suite, 
        // export only that module. Otherwise export all modules that were executed.
        if (!this.isRunningAll && this.currentFilter !== 'all' && !['pass', 'fail', 'pending'].includes(this.currentFilter)) {
            categoriesToExport = [this.currentFilter];
        }

        let overallIndex = 1;
        categoriesToExport.forEach(catId => {
            const catCommands = modelData.commands.filter(c => c.category === catId);
            if (catCommands.length === 0) return;

            // Category Group Header Row
            tableHtml += `
                <tr>
                    <td colspan="${colCount}" class="cat-header">${this.categoriesData[catId]?.label || catId.toUpperCase()}</td>
                </tr>
            `;

            catCommands.forEach(cmd => {
                const result = this.results[cmd.id];
                const status = result ? (result.success ? 'PASS' : 'FAIL') : 'PENDING';
                const statusClass = status.toLowerCase();
                const output = result ? result.output : '-';

                tableHtml += `<tr>`;
                activeCols.forEach(k => {
                    if (k === 'sno') tableHtml += `<td style="text-align: center">${overallIndex++}</td>`;
                    if (k === 'feature') tableHtml += `<td>${this.categoriesData[catId]?.label || catId.toUpperCase()}</td>`;
                    if (k === 'actions') tableHtml += `<td>${cmd.name}</td>`;
                    if (k === 'commands') tableHtml += `<td><code>${cmd.command}</code></td>`;
                    if (k === 'expected') tableHtml += `<td><code>${cmd.expected || this.getExpectedPattern(cmd.id) || '-'}</code></td>`;
                    if (k === 'output') tableHtml += `<td><pre>${output}</pre></td>`;
                    if (k === 'result') tableHtml += `<td class="${statusClass}">${status}</td>`;
                });
                tableHtml += `</tr>`;
            });
        });

        tableHtml += `</tbody></table></body></html>`;

        const filename = `Sanity_Report_${this.currentModel}_${new Date().toISOString().split('T')[0]}.xls`;
        const blob = new Blob([tableHtml], { type: 'application/vnd.ms-excel' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
        this.showToast('Excel Report Generated!', true);
    }

    async saveResultsToServer() {
        if (Object.keys(this.results).length === 0) return this.showToast('No results to save', false);

        try {
            const response = await this.apiCall('/api/save-results', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelId: this.currentModel,
                    results: this.results,
                    timestamp: new Date().toISOString()
                })
            });
            const data = await response.json();
            this.showToast('Results saved to server!', true);
        } catch (e) {
            this.showToast('Failed to save results', false);
        }
    }

    showClearConfirm() { document.getElementById('confirmClearModal').classList.add('active'); }
    closeClearConfirm() { document.getElementById('confirmClearModal').classList.remove('active'); }

    clearResults() {
        this.results = {};
        this.loadCommands();
        this.updateStats();
        this.closeClearConfirm();
        this.showToast('Results cleared', true);
    }



    showReport() {
        this.generateReport();
        this.setupReportControls();
        document.getElementById('reportModal').classList.add('active');
    }

    closeReport() {
        document.getElementById('reportModal').classList.remove('active');
    }

    generateReport() {
        const modelData = this.commandsData[this.currentModel];
        const reportHeader = document.querySelector('.report-header-info');
        const swVer = document.getElementById('swVersionDisplay').textContent;
        const region = document.getElementById('regionDisplay').textContent;
        const imei = document.getElementById('deviceIdDisplay').textContent;

        reportHeader.innerHTML = `
            <h1 id="reportModelName" style="color: var(--text-primary) !important; font-size: 2.8rem; text-transform: uppercase; margin-bottom: 5px; text-shadow: 0 0 20px rgba(99,102,241,0.3);">
                ${modelData.name}
            </h1>
            <p style="color: var(--text-secondary); font-size: 1.1rem;">Generated on: <span id="reportDate" style="color: var(--accent-primary);">${new Date().toLocaleString()}</span></p>
            
            <div class="report-extra-details" style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; font-size: 0.95rem;">
                <span style="background: rgba(255,255,255,0.05); padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border-color);">
                    <strong>Software:</strong> <span style="color: var(--success);">${swVer}</span>
                </span>
                <span style="background: rgba(255,255,255,0.05); padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border-color);">
                    <strong>Region:</strong> <span style="color: var(--accent);">${region}</span>
                </span>
                <span style="background: rgba(255,255,255,0.05); padding: 5px 10px; border-radius: 4px; border: 1px solid var(--border-color);">
                    <strong>IMEI:</strong> <span style="color: var(--text-primary);">${imei}</span>
                </span>
            </div>
            <div id="reportControlsContainer" style="margin-top: 15px;"></div>
        `;

        const enabledCols = {
            sno: document.querySelector('[data-col="sno"]').checked,
            feature: document.querySelector('[data-col="feature"]').checked,
            actions: document.querySelector('[data-col="actions"]').checked,
            commands: document.querySelector('[data-col="commands"]').checked,
            output: document.querySelector('[data-col="output"]').checked,
            expected: document.querySelector('[data-col="expected"]').checked,
            result: document.querySelector('[data-col="result"]').checked
        };

        const colHeaders = {
            sno: 'S.No',
            feature: 'Feature',
            actions: 'Actions',
            commands: 'Commands',
            output: 'Actual Output',
            expected: 'Expected Output',
            result: 'Result'
        };

        const activeCols = Object.keys(enabledCols).filter(k => enabledCols[k]);
        const colCount = activeCols.length;
        const container = document.getElementById('reportTableData');
        container.innerHTML = '';

        if (colCount === 0) {
            container.innerHTML = '<div class="text-center" style="padding: 20px; color: var(--text-muted);">Please select at least one column to view report.</div>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'sanity-report-table';

        // Dynamic Table Header
        let theadHtml = '<thead><tr>';
        activeCols.forEach(k => {
            theadHtml += `<th>${colHeaders[k]}</th>`;
        });
        theadHtml += '</tr></thead>';
        table.innerHTML = theadHtml;

        const tbody = document.createElement('tbody');
        let overallIndex = 1;

        // Support dynamic filtering for reports (module-based or all)
        let categoriesToReport = this.activeSuiteModules || modelData.categories;

        // Further filter by current UI filter if not 'all'
        if (this.currentFilter !== 'all' && !['pass', 'fail', 'pending'].includes(this.currentFilter)) {
            categoriesToReport = [this.currentFilter];
        }

        categoriesToReport.forEach(catId => {
            const catCommands = modelData.commands.filter(c => c.category === catId);
            if (catCommands.length === 0) return;

            // Category Header Row
            const catHeaderRow = document.createElement('tr');
            catHeaderRow.innerHTML = `<td colspan="${colCount}" class="report-cat-header">${this.categoriesData[catId]?.label || catId.toUpperCase()}</td>`;
            tbody.appendChild(catHeaderRow);

            catCommands.forEach(cmd => {
                const result = this.results[cmd.id];
                const tr = document.createElement('tr');
                tr.id = `report-row-${cmd.id}`;

                const statusText = result ? (result.success ? 'PASS' : 'FAIL') : 'PENDING';
                const statusClass = result ? (result.success ? 'report-pass' : 'report-fail') : 'report-pending';
                const output = result ? result.output : '-';
                const expected = cmd.expected || this.getExpectedPattern(cmd.id) || '-';

                let rowHtml = '';
                activeCols.forEach(k => {
                    if (k === 'sno') rowHtml += `<td>${overallIndex++}</td>`;
                    if (k === 'feature') rowHtml += `<td>${this.categoriesData[catId]?.label || catId.toUpperCase()}</td>`;
                    if (k === 'actions') rowHtml += `<td>${cmd.name}</td>`;
                    if (k === 'commands') rowHtml += `<td><code>${cmd.command}</code></td>`;
                    if (k === 'expected') rowHtml += `<td><code>${expected}</code></td>`;
                    if (k === 'output') rowHtml += `<td data-field="output"><pre class="report-output">${output}</pre></td>`;
                    if (k === 'result') rowHtml += `<td data-field="status" class="report-status-cell ${statusClass}">${statusText}</td>`;
                });
                tr.innerHTML = rowHtml;
                tbody.appendChild(tr);
            });
        });

        table.appendChild(tbody);
        container.appendChild(table);
    }

    updateReportRow(id) {
        const row = document.getElementById(`report-row-${id}`);
        if (!row) return;

        const result = this.results[id];
        const statusText = result ? (result.success ? 'PASS' : 'FAIL') : 'PENDING';
        const statusClass = result ? (result.success ? 'report-pass' : 'report-fail') : 'report-pending';
        const output = result ? result.output : '-';

        // Update Output Cell using data-field
        const outputCell = row.querySelector('[data-field="output"]');
        if (outputCell) outputCell.innerHTML = `<pre class="report-output">${output}</pre>`;

        // Update Status Cell using data-field
        const statusCell = row.querySelector('[data-field="status"]');
        if (statusCell) {
            statusCell.className = `report-status-cell ${statusClass}`;
            statusCell.textContent = statusText;
        }
    }

    getExpectedPattern(id) {
        const patterns = {
            'sim_state': 'SIM state\\s*:\\s*5',
            'iccid': 'ICCID\\s*:\\s*\\d+',
            'eid': 'EID\\s*:',
            'mcc': 'MCC\\s*:\\s*\\d+',
            'mnc': 'MNC\\s*:\\s*\\d+',
            'imei': 'IMEI\\s*:\\s*\\d+',
            'msisdn': 'MSISDN\\s*:',
            'imsi': 'IMSI\\s*:\\s*\\d+',
            'sim_oper': 'SIM operator\\s*:\\s*\\d+',
            'sim_country': 'SIM country ISO\\s*:\\s*\\w+',
            'sim_pin': 'SIM PIN Enabled\\s*:\\s*false',
            'sim_error': 'SIM error\\s*:\\s*0',
            'sim_prof_count': 'SIM profile count\\s*:\\s*\\d+',
            'net_reg_state': 'Network registration state.*:\\s*1',
            'service_state': 'Service state.*:\\s*0',
            'signal_strength': 'Signal Strength.*dBm',
            'lac': 'LAC\\s*:\\s*\\d+',
            'cid': 'CID\\s*:\\s*\\d+',
            'net_type': 'Network type\\s*:\\s*14',
            'net_oper': 'Network operator\\s*:\\s*\\d+',
            'temperature': 'Temperature\\s*:\\s*(-1|\\d+)',
            'net_class': 'Network class\\s*:\\s*3',
            'pref_net_type': 'Preferred network type\\s*:\\s*11',
            'radio_on': 'Result\\s*:\\s*true',
            'net_oper_name': 'Network operator name\\s*:\\s*.+',
            'net_roaming': 'Network roaming\\s*:\\s*false',
            'net_country': 'Network country ISO\\s*:\\s*\\w+',
            'data_net_type': 'Data network type\\s*:\\s*14',
            'get_apn_list': 'ProfileId',
            'enable_apn_def': 'Enable ApnType\\s*:\\s*[03]',
            'getDataRoamingEnabled': 'Get data roaming enabled\\s*:\\s*false',
            'setDataRoamingEnabled': 'set data roaming enabled\\s*:\\s*0',
            'getApnLoadSource': 'get current  apn source\\s*:\\s*0',
            'setUserDataEnabled': 'data enable or disable\\s*:\\s*0',
            'getDataState': 'Data connection state\\s*:\\s*2',
            'getDataConnectProperty': 'Connected',
            'getApnAddress': 'Apn Address\\s*:\\s*.+'
        };
        return patterns[id];
    }

    updateModuleVisibility() {
        const cats = this.commandsData[this.currentModel].categories;
        const current = this.currentFilter;

        // Modules only show when SPECIFICALLY selected, not in 'All Commands'
        document.getElementById('smsModule').style.display =
            (current === 'sms') && cats.includes('sms') ? 'block' : 'none';

        document.getElementById('callModule').style.display =
            (current === 'call') && cats.includes('call') ? 'block' : 'none';

        document.getElementById('regionModule').style.display =
            (current === 'region') && cats.includes('region') ? 'block' : 'none';

        document.getElementById('imeiModule').style.display =
            (current === 'network') && cats.includes('network') ? 'block' : 'none';

        // Clear results when switching
        document.querySelectorAll('.module-result').forEach(el => el.classList.remove('show'));
    }

    showResult(id) {
        const result = this.results[id];
        if (!result) return;
        document.getElementById('modalTitle').textContent = result.name;
        document.getElementById('modalCommand').textContent = result.command || 'Direct API Call';
        document.getElementById('modalOutput').textContent = result.output;
        document.getElementById('modalStatus').className = `result-status ${result.success ? 'pass' : 'fail'}`;
        document.getElementById('modalStatus').querySelector('.status-badge').textContent = result.success ? 'PASS' : 'FAIL';
        document.getElementById('resultModal').classList.add('active');
    }

    closeModal() { document.getElementById('resultModal').classList.remove('active'); }

    showToast(message, success, duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `toast ${success ? 'success' : 'error'}`;
        toast.innerHTML = `<span>${success ? '✅' : '❌'}</span> ${message}`;
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        container.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    showErrorPopup(title, message) {
        let modal = document.getElementById('errorModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'errorModal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 400px; border-color: var(--error);">
                    <div class="modal-header">
                        <h3 style="color: var(--error);" id="errorModalTitle"></h3>
                        <button class="modal-close" onclick="document.getElementById('errorModal').classList.remove('active')">&times;</button>
                    </div>
                    <div class="modal-body text-center">
                        <p id="errorModalMessage" style="white-space: pre-line; font-size: 1.1rem; color: var(--text-primary);"></p>
                        <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
                            <button class="btn-modal btn-danger" onclick="document.getElementById('errorModal').classList.remove('active')">Close</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        document.getElementById('errorModalTitle').textContent = title;
        document.getElementById('errorModalMessage').textContent = message;
        modal.classList.add('active');
    }

    showRegressionModal() {
        const container = document.getElementById('regStepContainer');
        container.innerHTML = '';
        this.addRegressionStep(); // Add first default step
        document.getElementById('regressionModal').classList.add('active');
    }

    addRegressionStep(commandId = '') {
        const container = document.getElementById('regStepContainer');
        const div = document.createElement('div');
        div.className = 'reg-step-row';
        div.style.display = 'flex';
        div.style.gap = '10px';
        div.style.alignItems = 'center';
        div.style.background = 'rgba(255,255,255,0.03)';
        div.style.padding = '8px';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid var(--border-color)';

        const modelData = this.commandsData[this.currentModel];
        const options = modelData.commands.map(cmd =>
            `<option value="${cmd.id}" ${cmd.id === commandId ? 'selected' : ''}>${cmd.name} (${cmd.command})</option>`
        ).join('');

        div.innerHTML = `
            <div style="color: var(--text-muted); font-size: 0.75rem; font-weight: bold; min-width: 50px;">STEP ${container.children.length + 1}</div>
            <select class="form-control reg-step-select" style="flex: 2; font-size: 0.85rem; height: 42px; padding: 8px 12px; line-height: 1;">
                ${options}
            </select>
            <input type="text" class="form-control reg-custom-param" placeholder="Enter Number" 
                style="display: none; flex: 1; font-size: 0.8rem; height: 32px; background: rgba(0,0,0,0.3); color: white; border: 1px solid var(--accent-primary);">
            <div style="display: flex; align-items: center; gap: 5px; background: rgba(0,0,0,0.2); padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
                <span style="font-size: 0.7rem; color: var(--text-muted); white-space: nowrap;">Wait (s)</span>
                <input type="number" class="reg-step-delay" value="1" min="0" max="60" 
                    style="width: 45px; background: transparent; border: none; color: var(--accent-primary); font-weight: bold; text-align: center; font-size: 0.9rem; outline: none;">
            </div>
            <button class="btn-remove-step" style="background: none; border: none; color: var(--error); cursor: pointer; font-size: 1.2rem; padding: 0 5px;">&times;</button>
        `;

        const select = div.querySelector('.reg-step-select');
        const customInput = div.querySelector('.reg-custom-param');

        const checkCustom = () => {
            const val = select.value.toLowerCase();
            // Show input for Dial or SMS commands
            if (val.includes('dial') || (val.includes('sms') && !val.includes('center'))) {
                customInput.style.display = 'block';
                if (!customInput.value) {
                    customInput.value = val.includes('dial') ? '7975602020' : '1234567890'; // Default suggestions
                }
            } else {
                customInput.style.display = 'none';
            }
        };

        select.addEventListener('change', checkCustom);
        // Initial check
        if (commandId) {
            // If creating from existing ID, wait for DOM then check
            setTimeout(checkCustom, 0);
        } else {
            // Default first item might be something random, usually user changes it. 
            // Better to trigger check immediately if the first option is 'dial'
            setTimeout(checkCustom, 0);
        }

        div.querySelector('.btn-remove-step').addEventListener('click', () => {
            if (container.children.length > 1) {
                div.remove();
                this.renumberSteps();
            } else {
                this.showToast('At least one step is required', false);
            }
        });

        container.appendChild(div);

        // If we just added a specific command that needs input, focus on input
        if (commandId && (commandId.includes('dial') || commandId.includes('sms'))) {
            setTimeout(() => customInput.focus(), 100);
        }
    }

    renumberSteps() {
        const rows = document.querySelectorAll('.reg-step-row');
        rows.forEach((row, i) => {
            row.firstElementChild.textContent = `STEP ${i + 1}`;
        });
    }

    closeRegressionModal() {
        if (this.isRegressionRunning && !confirm('Stop running regression?')) return;
        this.stopRegression = true;
        document.getElementById('regressionModal').classList.remove('active');
    }

    async startRegression() {
        const stepRows = document.querySelectorAll('.reg-step-row');
        const sequence = Array.from(stepRows).map(row => ({
            id: row.querySelector('.reg-step-select').value,
            delay: (parseInt(row.querySelector('.reg-step-delay').value) || 0) * 1000,
            customParam: row.querySelector('.reg-custom-param') ? row.querySelector('.reg-custom-param').value : '',
            useCustom: row.querySelector('.reg-custom-param') && row.querySelector('.reg-custom-param').style.display !== 'none'
        }));

        if (sequence.length === 0) return this.showToast('Please add at least one step', false);

        const iterations = parseInt(document.getElementById('regIterations').value) || 10;
        const log = document.getElementById('regressionLog');
        const startBtn = document.getElementById('btnStartRegression');
        const stopBtn = document.getElementById('btnStopRegression');
        const progressArea = document.getElementById('regProgress');

        if (this.isRegressionRunning) return;
        if (!this.deviceConnected) return this.showToast('Connect device first', false);

        // Reset UI
        this.isRegressionRunning = true;
        this.stopRegression = false;
        this.isRegressionPaused = false;
        startBtn.disabled = true;
        document.getElementById('btnPauseRegression').style.display = 'block';
        document.getElementById('btnPauseRegression').textContent = '⏸️ Pause';
        stopBtn.style.display = 'block';
        progressArea.style.display = 'block';

        // Show Live Status
        const liveStatusArea = document.getElementById('regLiveStatus');
        liveStatusArea.style.display = 'block';

        log.innerHTML = `<div style="color: var(--accent-primary); border-bottom: 2px solid var(--accent-primary); padding-bottom: 10px; margin-bottom: 10px;">
            🚀 REGRESSION STARTED: ${iterations} iterations | Sequence: ${sequence.length} steps
        </div>`;

        let passCount = 0;
        let failCount = 0;
        this.regressionHistory = [];
        document.getElementById('regTotalCount').textContent = iterations;

        for (let i = 1; i <= iterations; i++) {
            // Give UI a chance to breathe
            await new Promise(r => setTimeout(r, 0));

            if (this.stopRegression) {
                log.innerHTML += `<div style="color: var(--error); margin-top: 10px; font-weight: bold;">🛑 REGRESSION STOPPED BY USER</div>`;
                break;
            }

            while (this.isRegressionPaused && !this.stopRegression) {
                await new Promise(r => setTimeout(r, 500));
            }

            if (this.stopRegression) break;

            document.getElementById('regCurrentIdx').textContent = i;
            const percent = (i / iterations) * 100;
            document.getElementById('regProgressBar').style.width = percent + '%';

            let iterationFail = false;

            for (let sIdx = 0; sIdx < sequence.length; sIdx++) {
                const step = sequence[sIdx];
                const stepNum = sIdx + 1;

                // Log Entry for this specific step
                const time = new Date().toLocaleTimeString();
                const entryEl = document.createElement('div');
                entryEl.className = 'reg-log-entry';
                entryEl.innerHTML = `
                    <span class="reg-log-time">[${time}]</span>
                    <span class="reg-log-iter">#${i}-${stepNum}</span>
                    <span class="reg-log-status">RUNNING...</span>
                    <span class="reg-log-output">Step ${stepNum}: Executing...</span>
                `;
                log.appendChild(entryEl);
                log.scrollTop = log.scrollHeight;

                if (!this.deviceConnected) {
                    log.innerHTML += `<div style="color: var(--error); margin-top: 10px; font-weight: bold;">❌ ERROR: Device Disconnected</div>`;
                    this.stopRegression = true;
                    break;
                }

                // Update Generic Status UI
                const statusContent = document.getElementById('regStatusContent');
                const isCall = step.id.toLowerCase().includes('dial') || step.id.toLowerCase().includes('call');

                if (!isCall) {
                    statusContent.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div class="status-dot" style="width: 12px; height: 12px; background: var(--warning); box-shadow: 0 0 10px var(--warning);"></div>
                            <div>
                                <div style="font-weight: 700; font-size: 1.1rem; color: var(--warning);">EXECUTING STEP ${stepNum}/${sequence.length}</div>
                                <div style="font-size: 0.8rem; color: var(--text-muted);">Iteration #${i} in progress...</div>
                            </div>
                        </div>
                    `;
                }

                try {
                    let overrideCommand = null;
                    if (step.useCustom && step.customParam) {
                        const cmdObj = this.commandsData[this.currentModel].commands.find(c => c.id === step.id);
                        if (cmdObj) {
                            const parts = cmdObj.command.split(' ');
                            if (step.id.includes('dial')) {
                                // Replace last param for dial
                                // Check if keyword 'dial' exists 
                                const idx = parts.indexOf('dial');
                                if (idx !== -1 && parts[idx + 1]) parts[idx + 1] = step.customParam;
                                else parts[parts.length - 1] = step.customParam; // Fallback
                                overrideCommand = parts.join(' ');
                            } else if (step.id.includes('sms')) {
                                const idx = parts.indexOf('sendSms16');
                                if (idx !== -1 && parts[idx + 1]) {
                                    parts[idx + 1] = step.customParam;
                                    overrideCommand = parts.join(' ');
                                }
                            }
                        }
                    }

                    const res = await this.runCommand(step.id, true, overrideCommand);
                    const statusSpan = entryEl.querySelector('.reg-log-status');
                    const outSpan = entryEl.querySelector('.reg-log-output');

                    if (res.success) {
                        statusSpan.className = 'reg-log-status pass';
                        statusSpan.textContent = 'PASS';
                    } else {
                        statusSpan.className = 'reg-log-status fail';
                        statusSpan.textContent = 'FAIL';
                        iterationFail = true;
                    }
                    outSpan.textContent = `[Step ${stepNum}] ${res.output}`;

                    // Store history
                    this.regressionHistory.push({
                        iteration: i,
                        step: stepNum,
                        time: time,
                        commandName: this.commandsData[this.currentModel].commands.find(c => c.id === step.id)?.name || step.id,
                        commandId: step.id,
                        output: res.output,
                        status: res.success ? 'PASS' : 'FAIL'
                    });
                } catch (e) {
                    iterationFail = true;
                }

                if (this.stopRegression) break;

                // Use per-step delay set by user
                if (step.delay > 0) {
                    const waitEntry = document.createElement('div');
                    waitEntry.style.fontSize = '0.75rem';
                    waitEntry.style.color = 'var(--text-muted)';
                    waitEntry.style.paddingLeft = '85px';
                    waitEntry.innerHTML = `⏳ Waiting ${step.delay / 1000}s...`;
                    log.appendChild(waitEntry);
                    log.scrollTop = log.scrollHeight;

                    const stepWaitStart = Date.now();
                    while (Date.now() - stepWaitStart < step.delay) {
                        if (this.stopRegression) break;
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            }

            if (iterationFail) failCount++;
            else passCount++;

            document.getElementById('regPassCount').textContent = passCount;
            document.getElementById('regFailCount').textContent = failCount;

            if (this.stopRegression) break;
        }

        this.isRegressionRunning = false;
        startBtn.disabled = false;
        document.getElementById('btnPauseRegression').style.display = 'none';
        stopBtn.style.display = 'none';
        log.innerHTML += `<div style="color: var(--success); font-weight: bold; margin-top: 15px; border-top: 1px solid var(--success); padding-top: 10px;">
            ✅ REGRESSION COMPLETED: ${passCount} Pass, ${failCount} Fail
        </div>`;
        log.scrollTop = log.scrollHeight;
    }

    showRegModuleSelection() {
        const modelCategories = this.commandsData[this.currentModel].categories || [];

        // Quick solution: Create a small picker dynamically
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.zIndex = '10000';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100vw';
        overlay.style.height = '100vh';
        overlay.style.background = 'rgba(0,0,0,0.7)';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';

        const card = document.createElement('div');
        card.style.background = 'var(--bg-card)'; // Assuming this var exists, else use #1e1e24
        card.style.backgroundColor = '#1e1e24';
        card.style.padding = '20px';
        card.style.borderRadius = '8px';
        card.style.width = '300px';
        card.style.border = '1px solid var(--border-color)';

        card.innerHTML = `<h3>Add Module Group</h3><p style="margin-bottom:10px; color: var(--text-secondary);">Select module to add all its commands:</p>`;

        modelCategories.forEach(catId => {
            const btn = document.createElement('button');
            btn.className = 'btn-secondary w-100';
            btn.style.marginBottom = '5px';
            btn.style.textAlign = 'left';
            btn.textContent = this.categoriesData[catId]?.label || catId;
            btn.onclick = () => {
                this.addModuleRegressionSteps(catId);
                document.body.removeChild(overlay);
            };
            card.appendChild(btn);
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-danger w-100';
        closeBtn.style.marginTop = '10px';
        closeBtn.textContent = 'Cancel';
        closeBtn.onclick = () => document.body.removeChild(overlay);
        card.appendChild(closeBtn);

        overlay.appendChild(card);
        document.body.appendChild(overlay);
    }

    addModuleRegressionSteps(catId) {
        const commands = this.commandsData[this.currentModel].commands.filter(c => c.category === catId);
        if (commands.length === 0) return this.showToast('No commands in this module', false);

        // If the container only has one step and it's the default blank one, maybe replace it? 
        // For now, just append.
        commands.forEach(cmd => {
            this.addRegressionStep(cmd.id);
        });
        this.showToast(`Added ${commands.length} steps from module`, true);
    }

    clearRegressionLog() {
        document.getElementById('regressionLog').innerHTML = '<div style="color: var(--text-muted); text-align: center;">Log cleared. Waiting to start...</div>';
        document.getElementById('regPassCount').textContent = '0';
        document.getElementById('regFailCount').textContent = '0';
        document.getElementById('regCurrentIdx').textContent = '0';
        document.getElementById('regProgressBar').style.width = '0%';
        this.regressionHistory = [];
    }

    exportRegressionReport() {
        if (!this.regressionHistory || this.regressionHistory.length === 0) {
            return this.showToast('No regression data to export', false);
        }

        const headers = ['Iteration', 'Step', 'Time', 'Command Name', 'Command ID', 'Status', 'Output'];
        const csvContent = [
            headers.join(','),
            ...this.regressionHistory.map(row => {
                const safeOutput = (row.output || '').replace(/"/g, '""').replace(/\n/g, ' ');
                return [
                    row.iteration,
                    row.step,
                    row.time,
                    `"${row.commandName}"`,
                    row.commandId,
                    row.status,
                    `"${safeOutput}"`
                ].join(',');
            })
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `regression_report_${this.currentModel}_${Date.now()}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    toggleRegressionPause() {
        this.isRegressionPaused = !this.isRegressionPaused;
        const btn = document.getElementById('btnPauseRegression');
        if (btn) {
            btn.textContent = this.isRegressionPaused ? '▶️ Resume' : '⏸️ Pause';
            btn.className = this.isRegressionPaused ? 'btn-success' : 'btn-warning';
        }
        const log = document.getElementById('regressionLog');
        if (log) {
            const time = new Date().toLocaleTimeString();
            log.innerHTML += `<div style="color: var(--warning); padding: 5px 0;">[${time}] ${this.isRegressionPaused ? '⏸️ Regression Paused' : '▶️ Regression Resumed'}</div>`;
            log.scrollTop = log.scrollHeight;
        }
    }

    showDeviceDisconnectedPopup(disconnectedSerial, availableDevices = []) {
        let modal = document.getElementById('deviceDisconnectedModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'deviceDisconnectedModal';
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content" style="max-width: 450px; border-color: var(--warning);">
                    <div class="modal-header">
                        <h3 style="color: var(--warning);">⚠️ Device Disconnected</h3>
                        <button class="modal-close" onclick="document.getElementById('deviceDisconnectedModal').classList.remove('active')">&times;</button>
                    </div>
                    <div class="modal-body text-center">
                        <p id="disconnectedMessage" style="white-space: pre-line; font-size: 1.1rem; color: var(--text-primary);"></p>
                        <div id="availableDevicesList" style="margin-top: 15px;"></div>
                        <div class="modal-actions" style="justify-content: center; margin-top: 20px; gap: 10px;">
                            <button class="btn-secondary" style="margin: 5px; padding: 8px 15px;" 
                                onclick="app.fetchDevices(); document.getElementById('deviceDisconnectedModal').classList.remove('active');">
                                🔄 Refresh Devices
                            </button>
                            <button class="btn-modal btn-danger" onclick="document.getElementById('deviceDisconnectedModal').classList.remove('active')">Close</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        const msg = `Your selected device '${disconnectedSerial}' is disconnected.\n\nPlease reconnect the device or select another one.`;
        document.getElementById('disconnectedMessage').textContent = msg;

        const listDiv = document.getElementById('availableDevicesList');
        if (availableDevices.length > 0) {
            listDiv.innerHTML = `
                <p style="color: var(--text-muted); margin-bottom: 10px;">Available devices:</p>
                ${availableDevices.map(id => `
                    <button class="btn-secondary" style="margin: 5px; padding: 8px 15px;" 
                        onclick="app.handleDeviceChange('${id}', true); document.getElementById('deviceDisconnectedModal').classList.remove('active');">
                        📱 ${id}
                    </button>
                `).join('')}
            `;
        } else {
            listDiv.innerHTML = '<p style="color: var(--error);">No other devices available.</p>';
        }

        modal.classList.add('active');

        // Also update the device status in the UI
        this.deviceConnected = false;
        this.fetchDevices();
    }
    async launchDLT() {
        try {
            const configText = document.getElementById('dltCurrentConfig');
            if (configText) configText.textContent = `⏳ Bridge: ${this.dltPort}`;

            const response = await this.apiCall('/api/tools/launch-dlt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    adbCommand: this.adbCommand,
                    dltPort: this.dltPort
                })
            });

            if (!response.ok) {
                if (configText) configText.textContent = `❌ Bridge Error`;
                return;
            }

            const data = await response.json();
            if (data.success) {
                if (configText) configText.textContent = `Bridge: ${this.dltPort}`;
                console.log('[DLT] Bridge Ready on ' + this.dltPort);
            } else {
                if (configText) configText.textContent = `❌ ${data.error}`;
            }
        } catch (e) {
            console.error('[DLT]', e);
        }
    }

    showDLTConfig() {
        document.getElementById('dltPortInput').value = this.dltPort;

        // Update values in the Remote Connection Guide
        const serverIp = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
        document.getElementById('remoteGuideIp').textContent = serverIp;
        document.getElementById('remoteGuidePort').textContent = this.dltPort;

        document.getElementById('dltConfigModal').classList.add('active');
    }

    saveDLTConfig() {
        const port = document.getElementById('dltPortInput').value.trim();

        if (!port) {
            this.showToast('Please provide a port number', false);
            return;
        }

        this.dltPort = port;
        localStorage.setItem('dltPort', port);

        // Update sidebar text
        document.getElementById('dltCurrentConfig').textContent = `Bridge: ${port}`;

        this.showToast('DLT Settings Saved', true);
        document.getElementById('dltConfigModal').classList.remove('active');

        // Auto-refresh bridge with new port
        this.launchDLT();
    }
}

const app = new TelephonyManager();
window.app = app;

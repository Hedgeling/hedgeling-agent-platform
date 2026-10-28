(function consoleShell() {
  const $ = (id) => document.getElementById(id);
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
  const library = [
    ["glossary", "Glossary", "Shared terminology, approved words, and do-not-translate rules."],
    ["personas", "Personas", "Voice and tone that feel right in every language."],
    ["prompts", "Translation instructions", "Reusable instructions for consistent AI translations."],
  ];
  const admin = [["people", "People & access"], ["structure", "Organization"], ["identity", "Identity & API"], ["billing", "Billing & usage"], ["providers", "AI providers & keys"], ["agencies", "Agencies"], ["usage", "Usage & budgets"], ["payments", "Payments"], ["audit", "Audit history"]];
  let state = { projects: [], organizations: [], assignments: [], permissions: [], view: "home" };
  let adminSection = "people";
  let agentOrganizations = [];
  let workspaceOrganizationId = null;
  let canCreateOrganization = false;
  let agentReady = false;
  const drawerInert = new Map();
  const mobile = matchMedia("(max-width: 900px)");
  try { document.body.dataset.sidebarCollapsed = String(localStorage.getItem("hedgeling.sidebar.collapsed") === "true"); } catch { /* Keep the default expanded navigation. */ }
  $("sidebarCollapse").setAttribute("aria-expanded", String(document.body.dataset.sidebarCollapsed !== "true"));
  $("sidebarCollapse").setAttribute("aria-label", document.body.dataset.sidebarCollapsed === "true" ? "Expand sidebar" : "Collapse sidebar");

  function organizationList() {
    const result = new Map([...agentOrganizations, ...state.organizations].map((o) => [o.id, o]));
    for (const p of state.projects) if (!result.has(p.organizationId)) result.set(p.organizationId, { id: p.organizationId, name: p.organizationName });
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function renderPicker() {
    const term = $("workspaceSearch").value.trim().toLowerCase();
    const rows = ['<button type="button" data-view="home">All workspaces</button>'];
    for (const org of organizationList()) {
      const projects = state.projects.filter((p) => p.organizationId === org.id && `${org.name} ${p.businessUnitName} ${p.name}`.toLowerCase().includes(term));
      if (term && !org.name.toLowerCase().includes(term) && !projects.length) continue;
      rows.push(`<button class="workspace-org-option" type="button" data-browse-org="${html(org.id)}">${html(org.name)}</button>`);
      let unit = null;
      for (const project of projects) {
        if (unit !== project.businessUnitId) { unit = project.businessUnitId; rows.push(`<span class="workspace-unit">${html(project.businessUnitName)}</span>`); }
        rows.push(`<button type="button" class="workspace-project-option" data-open-project="${html(project.slug)}" ${project.slug === state.projectSlug ? 'aria-current="true"' : ""}>${html(project.name)}</button>`);
      }
    }
    if (rows.length === 1 && term) rows.push('<p class="shell-empty">No matching workspaces or projects.</p>');
    $("workspaceOptions").innerHTML = rows.join("");
    document.querySelector("[data-workspace-new]").hidden = !canCreateOrganization;
  }
  function renderContext() {
    const project = state.projects.find((p) => p.slug === state.projectSlug);
    if (["review", "library", "glossary", "personas", "prompts"].includes(state.view) && project) {
      $("workspaceContextLabel").textContent = `${project.organizationName} / ${project.businessUnitName}`;
      $("projectName").textContent = project.name;
    } else if (state.view === "workspace" && workspaceOrganizationId) {
      $("workspaceContextLabel").textContent = "Projects";
      $("projectName").textContent = organizationList().find((o) => o.id === workspaceOrganizationId)?.name || "Workspace";
    } else if (state.view === "access") {
      $("workspaceContextLabel").textContent = "Admin";
      $("projectName").textContent = $("accessOrganization").selectedOptions[0]?.textContent || "Organization";
    } else {
      $("workspaceContextLabel").textContent = state.view === "operations" ? "Platform" : "Workspace";
      $("projectName").textContent = state.view === "operations" ? "Operations" : "All workspaces";
    }
  }
  function renderHome() {
    const pending = state.assignments.filter((a) => !["completed", "cancelled"].includes(a.workOrderStatus));
    $("homeOverview").innerHTML = [["Projects", state.projects.length], ["Organizations", organizationList().length], ["Active assignments", pending.length]].map(([label, n]) => `<div class="overview-card"><span>${label}</span><strong>${n}</strong></div>`).join("");
    $("homeProjects").innerHTML = state.projects.slice(0, 4).map((p) => `<button type="button" class="home-project-card" data-open-project="${html(p.slug)}"><strong>${html(p.name)} <span aria-hidden="true">↗</span></strong><small>${html(p.organizationName)} / ${html(p.businessUnitName)}</small></button>`).join("") || '<p class="shell-empty">Your projects will appear here. Open Projects to explore or create a workspace.</p>';
    $("homeWork").innerHTML = pending.slice(0, 3).map((a) => `<button type="button" class="home-assignment-card" data-open-assignment="${html(a.id)}"><strong>${html(a.title)}</strong><small>${html(a.projectName)} · ${html(a.targetLocale)} · ${html(a.workOrderStatus.replaceAll("_", " "))}</small></button>`).join("") || '<p class="shell-empty">Nothing assigned to you yet.<br>When work is assigned, you’ll find it here.</p>';
    $("workCount").textContent = pending.length;
    $("workCount").hidden = !pending.length;
    $("libraryCards").innerHTML = library.filter(([key]) => ["view","propose","approve","manage"].some(action => state.permissions.includes(`${key}.${action}`))).map(([key, label, description], i) => `<button type="button" class="library-card" data-view="${key}"><span>0${i + 1} ↗</span><strong>${label}</strong><p>${description}</p></button>`).join("");
  }
  function renderSections() {
    let items = [];
    let active = state.view;
    let visibleAdminSection = adminSection;
    if (["work", "review"].includes(state.view)) {
      items = [["work", "Assignments"], ...(state.permissions.includes("strings.view") ? [["review", "Review"]] : [])];
    } else if (["library", "glossary", "personas", "prompts"].includes(state.view)) {
      items = [["library", "Overview"], ...library.filter(([key]) => ["view","propose","approve","manage"].some(action => state.permissions.includes(`${key}.${action}`)))];
    } else if (["access", "operations"].includes(state.view)) {
      const permissions = state.organizations.find((o) => o.id === $("accessOrganization").value)?.permissions || [];
      const required = { identity: ["identity.manage", "api_credentials.manage", "provisioning.manage"], billing: ["billing.view"], providers: ["ai_providers.view"], agencies: ["vendors.view"], usage: ["usage.view"], audit: ["audit.view"] };
      items = state.organizations.length ? admin.filter(([key]) => key === "payments" ? !$("facilitatedPaymentsCard").hidden : !required[key] || required[key].some((p) => permissions.includes(p))).map(([key, label]) => [`access/${key}`, label]) : [];
      if (state.canOperate) items.push(["operations", "Operations"]);
      if (state.view === "access") {
        if (!items.some(([key]) => key === `access/${adminSection}`)) visibleAdminSection = items.find(([key]) => key.startsWith("access/"))?.[0].split("/")[1] || "people";
        active = `access/${visibleAdminSection}`;
        $("adminHeading").textContent = admin.find(([key]) => key === visibleAdminSection)?.[1] || "Admin";
      }
    }
    for (const node of document.querySelectorAll("[data-admin-section]")) node.dataset.sectionHidden = String(node.dataset.adminSection !== visibleAdminSection);
    $("sectionNav").hidden = !items.length;
    $("sectionNav").innerHTML = items.map(([key, label]) => `<button type="button" data-view="${key.split("/")[0]}" ${key.includes("/") ? `data-admin-target="${key.split("/")[1]}"` : ""} class="${key === active ? "active" : ""}" ${key === active ? 'aria-current="page"' : ""}>${label}</button>`).join("");
  }
  function update(next) {
    state = next;
    $("libraryTab").hidden = !library.some(([key]) => ["view","propose","approve","manage"].some(action => state.permissions.includes(`${key}.${action}`)));
    $("adminTab").hidden = !state.organizations.length && !state.canOperate;
    $("adminTab").dataset.view = state.organizations.length ? "access" : "operations";
    const section = ["review", "work"].includes(state.view) ? "work" : ["library", "glossary", "personas", "prompts"].includes(state.view) ? "library" : ["access", "operations"].includes(state.view) ? $("adminTab").dataset.view : state.view;
    for (const button of document.querySelectorAll(".console-sidebar [data-view]")) {
      const active = button.dataset.view === section;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    const user = state.user || {};
    $("accountName").textContent = user.displayName || "Your account";
    $("accountEmail").textContent = user.email || "";
    $("accountAvatar").textContent = (user.displayName || user.email || "U").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    renderPicker(); renderHome(); renderContext(); renderSections();
    if (!agentReady) $("workspaceRoot").innerHTML = '<p class="shell-eyebrow">PROJECTS</p><h1>Your projects</h1><p class="shell-description">Choose a project to open its content.</p><div class="home-projects">' + state.projects.map((p) => `<button type="button" class="home-project-card" data-open-project="${html(p.slug)}"><strong>${html(p.name)}</strong><small>${html(p.organizationName)} / ${html(p.businessUnitName)}</small></button>`).join("") + (state.projects.length ? "" : '<p class="shell-empty">No projects are available yet.</p>') + "</div>";
  }
  function setDrawer(open) {
    document.body.dataset.sidebarOpen = String(open);
    $("sidebarDismiss").hidden = !open;
    $("sidebarToggle").setAttribute("aria-expanded", String(open));
    // The drawer behaves as a modal navigation surface on small screens.
    if (open) {
      for (const node of [$("consoleMain"), $("accountMenu"), $("workspacePicker"), $("askAgent"), document.querySelector(".agent-launcher")].filter(Boolean)) {
        if (!drawerInert.has(node)) drawerInert.set(node, node.inert);
        node.inert = true;
      }
    } else { for (const [node, inert] of drawerInert) node.inert = inert; drawerInert.clear(); }
    if (open) $("consoleSidebar").querySelector("[data-view]").focus();
  }
  function dismissMenus() { $("workspacePicker").open = false; $("accountMenu").open = false; if (mobile.matches) setDrawer(false); }
  const route = () => { const [view, section] = location.hash.slice(1).split("/"); return { view, adminSection: section }; };
  function setRoute(view, section, manual, fromHistory) {
    if (section && admin.some(([key]) => key === section)) adminSection = section;
    const hash = `#${view}${view === "access" ? `/${adminSection}` : ""}`;
    if (!fromHistory && location.hash !== hash) history[manual ? "pushState" : "replaceState"]({}, "", `${location.pathname}${location.search}${hash}`);
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest(".skip-link")) { event.preventDefault(); $("consoleMain").focus(); return; }
    const view = event.target.closest("button[data-view]");
    const project = event.target.closest("[data-open-project]");
    const org = event.target.closest("[data-browse-org]");
    const newOrg = event.target.closest("[data-workspace-new]");
    const assignment = event.target.closest("[data-open-assignment]");
    if (view) { dismissMenus(); window.HedgelingConsole?.navigate(view.dataset.view, { manual: true, adminSection: view.dataset.adminTarget }); }
    if (project) { dismissMenus(); window.HedgelingConsole?.openProject(project.dataset.openProject, { manual: true }).catch(showError); }
    if (org || newOrg) {
      dismissMenus();
      const id = org?.dataset.browseOrg || null;
      if (id && state.view === "access" && state.organizations.some((o) => o.id === id)) window.HedgelingConsole?.openOrganization(id).catch(showError);
      else browseWorkspace(id).catch(showError);
    }
    if (assignment) { dismissMenus(); window.HedgelingConsole?.openAssignment(assignment.dataset.openAssignment).catch(showError); }
    if (event.target.closest("[data-ask-agent]")) { dismissMenus(); window.HedgelingAgent?.open(); }
    if (!event.target.closest("#accountMenu")) $("accountMenu").open = false;
    if (!event.target.closest("#workspacePicker")) $("workspacePicker").open = false;
  });
  function showError(error) { window.HedgelingConsole?.notify(error.message); }
  async function browseWorkspace(id) {
    window.HedgelingConsole?.navigate("workspace", { manual: true, load: false });
    if (window.HedgelingAgent) await window.HedgelingAgent.browseWorkspace(id);
    workspaceOrganizationId = id; renderContext();
  }
  $("workspaceSearch").addEventListener("input", renderPicker);
  $("workspacePicker").addEventListener("toggle", () => { if ($("workspacePicker").open) { $("accountMenu").open = false; $("workspaceSearch").focus(); } });
  $("sidebarCollapse").addEventListener("click", () => {
    const collapsed = document.body.dataset.sidebarCollapsed !== "true";
    document.body.dataset.sidebarCollapsed = String(collapsed);
    $("sidebarCollapse").setAttribute("aria-expanded", String(!collapsed));
    $("sidebarCollapse").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    try { localStorage.setItem("hedgeling.sidebar.collapsed", String(collapsed)); } catch { /* Session-only preference. */ }
  });
  $("sidebarToggle").addEventListener("click", () => setDrawer(document.body.dataset.sidebarOpen !== "true"));
  $("sidebarDismiss").addEventListener("click", () => { setDrawer(false); $("sidebarToggle").focus(); });
  mobile.addEventListener("change", () => setDrawer(false));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); dismissMenus(); window.HedgelingAgent?.open(); }
    if (event.key === "Escape") {
      if ($("accountMenu").open) { $("accountMenu").open = false; $("accountMenu").querySelector("summary").focus(); }
      if ($("workspacePicker").open) { $("workspacePicker").open = false; $("workspacePicker").querySelector("summary").focus(); }
      if (document.body.dataset.sidebarOpen === "true") { setDrawer(false); $("sidebarToggle").focus(); }
    }
    if (event.key === "Tab" && document.body.dataset.sidebarOpen === "true") {
      const nodes = [...$("consoleSidebar").querySelectorAll("a,button")].filter((n) => n.getClientRects().length && !n.hidden);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    }
  });
  addEventListener("hashchange", () => { const target = route(); window.HedgelingConsole?.navigate(target.view || "home", { ...target, manual: true, fromHistory: true }); });
  window.HedgelingShell = {
    update, route, setRoute,
    organizationContext() {
      if (state.view === "workspace") return workspaceOrganizationId;
      if (["review", "library", "glossary", "personas", "prompts"].includes(state.view)) return state.projects.find((p) => p.slug === state.projectSlug)?.organizationId;
      if (state.view === "access") return $("accessOrganization").value || undefined;
      // Global pages have no selected organization; keep the current chat there.
      return undefined;
    },
    workspaceChanged(id) { workspaceOrganizationId = id; renderContext(); },
    agentAvailable(config, brand) {
      agentReady = true; agentOrganizations = config.organizations; canCreateOrganization = config.organizationCreation;
      for (const button of document.querySelectorAll("[data-ask-agent]")) button.disabled = false;
      if (brand) {
        for (const node of document.querySelectorAll("[data-agent-label]")) node.textContent = `Ask ${brand.agentName}`;
        $("askAgent").setAttribute("aria-label", `Ask ${brand.agentName}`);
        document.querySelector(".sidebar-brand").setAttribute("aria-label", `${brand.productName} home`);
      }
      renderPicker(); renderHome();
    },
  };
})();

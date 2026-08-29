import { useEffect, useRef, useState } from "react";
import {
  CalendarClock, CalendarDays, Hand, Loader2, Maximize2, Monitor, Moon, Plus, Power, Settings, Smartphone, X,
} from "lucide-react";
import { orchestrationFetch } from "@/lib/orchestration";
import { useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { LocalScreenPreview } from "./LocalScreenPreview";

async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await orchestrationFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

type Phase = "checking" | "unconfigured" | "starting" | "ready" | "off" | "error";

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence = days.length === 7
    ? "Every day"
    : days.join(",") === "1,2,3,4,5"
      ? "Weekdays"
      : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [panelView, setPanelView] = useState<"computer" | "android">("computer");
  const [retry, setRetry] = useState(0);
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  const selectedInstance = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const cloudSupported = selectedInstance?.capabilities?.computerMcp === true || selectedInstance?.driverKind === "boxAgent";

  useEffect(() => {
    let alive = true;
    const desktopViewer = window.ogb?.desktopViewer;
    if (desktopViewer?.currentState) {
      void desktopViewer.currentState().then((viewer) => {
        if (alive) setViewerOpen(viewer.open && viewer.contextId === bot.id);
      }).catch(() => {});
    }
    const unsubscribe = desktopViewer?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => { alive = false; unsubscribe?.(); };
  }, [bot.id]);

  useEffect(() => {
    if (!androidConnected && panelView === "android") setPanelView("computer");
  }, [androidConnected, panelView]);

  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setError(null);
    if (bot.computer === "off") { setPhase("off"); return; }
    if (!cloudSupported) {
      setError("This model engine cannot use cloud computer tools. Choose Claude, an ACP engine, or the Computer engine.");
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" || (bot.cloudBackend && bot.cloudBackend !== "box")) {
      dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "cloud", cloudBackend: "box" } });
      return;
    }
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        if (!status.configured) { setPhase("unconfigured"); return; }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
          if (!alive) return;
          setBoxState(result.state ?? null);
          setPhase("ready");
        });
      })
      .catch((cause) => {
        if (!alive) { return; }
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      });
    return () => { alive = false; };
  }, [bot.cloudBackend, bot.computer, bot.id, cloudSupported, dispatch, retry]);

  const pageVisible = usePageVisible();
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || sseFlowing || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch { /* retry on the next poll */ }
      finally { inFlight.current = false; }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 4000 : 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [bot.busy, bot.id, pageVisible, phase, sseFlowing, viewerOpen]);

  const lastScreen = [...bot.messages].reverse().find((message) => message.kind === "screen" && message.png);
  const cloudFrame = live ?? polledFrame ?? (lastScreen
    ? { png: lastScreen.png!, mime: lastScreen.mime ?? "image/png" }
    : null);
  const frameSrc = phase === "ready" || phase === "starting"
    ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
    : null;
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`).then((snapshot) => {
      if (!alive) return;
      dispatch({
        type: "computerControl", botId: bot.id, held: snapshot.held === true,
        helpReason: typeof snapshot.helpReason === "string" ? snapshot.helpReason : null,
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [bot.id, dispatch]);

  const requestControl = async (action: "take" | "release" | "dismiss-help") => {
    const snapshot = await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST", body: JSON.stringify({ action }),
    });
    dispatch({
      type: "computerControl", botId: bot.id, held: snapshot.held === true,
      helpReason: typeof snapshot.helpReason === "string" ? snapshot.helpReason : null,
    });
  };

  const controlAction = (action: "release" | "dismiss-help") => {
    setControlPending(true);
    requestControl(action)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setControlPending(false));
  };

  const openDesktop = async () => {
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) { await requestControl("take"); tookControl = true; }
      const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
      const viewerUrl = typeof result.joinUrl === "string" ? result.joinUrl : null;
      if (!viewerUrl) throw new Error("The computer did not return a live desktop link");
      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, `${bot.name}'s live desktop`, bot.id);
        if (!opened) throw new Error("Roundtable could not open the live desktop");
      } else if (fallbackTab) fallbackTab.location.replace(viewerUrl);
      else if (window.ogb?.openExternal) {
        if (!await window.ogb.openExternal(viewerUrl)) throw new Error("Roundtable could not open the live desktop link");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) throw new Error("Your browser blocked the live desktop tab");
    } catch (cause) {
      fallbackTab?.close();
      if (tookControl) await requestControl("release").catch(() => {});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(null); setControlPending(false); }
  };

  const sleep = () => {
    setPending("sleep");
    setError(null);
    api(`/api/bots/${bot.id}/computer/sleep`, { method: "POST" })
      .then(() => setBoxState("archived"))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };

  const emptyState: Record<Exclude<Phase, "ready">, string> = {
    checking: "Checking…", starting: "Starting your bot's computer…", unconfigured: "No cloud computer configured",
    off: "This bot's computer is off", error: "Couldn't reach the computer",
  };
  const botRoutines = state.routines.filter((routine) => routine.botId === bot.id)
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || (left.nextRunAt ?? Infinity) - (right.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(state.config?.box.configured && state.instances.some(
    (instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available",
  ));
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={() => dispatch({ type: "toggleSettings", open: true })} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" title="Bot settings"><Settings size={18} /></button>
        {androidConnected ? (
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            <button onClick={() => setPanelView("computer")} aria-pressed={panelView === "computer"} className={cn("flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]", panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink")}><Monitor size={13} /> Computer</button>
            <button onClick={() => setPanelView("android")} aria-pressed={panelView === "android"} className={cn("flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]", panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink")}><Smartphone size={13} /> Android</button>
          </div>
        ) : <span className="text-[15px] font-semibold text-ink">Computer</span>}
        <button onClick={() => dispatch({ type: "toggleComputer", open: false })} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink" aria-label="Close computer panel"><X size={18} /></button>
      </div>

      {panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2"><AndroidDevicePanel status={androidStatus} /></div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary"><span>{bot.name}'s screen</span>{(phase === "ready" || phase === "starting") && <span className="text-[11px]">Box</span>}</div>
          <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
            {frameSrc && phase === "ready" ? (
              <button type="button" onClick={() => void openDesktop()} disabled={controlPending || pending === "join"} className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait" aria-label={`Open ${bot.name}'s live desktop`} title="Open live desktop">
                <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain transition group-hover:brightness-75" />
                <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100">{pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}Open</span>
              </button>
            ) : frameSrc ? <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain" /> : (
              <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                {phase === "checking" || phase === "starting" ? <Loader2 size={18} className="animate-spin" /> : phase === "off" ? <Power size={22} /> : <Monitor size={22} />}
                <span className="text-[12px]">{phase === "ready" ? "Waiting for the first frame…" : emptyState[phase]}</span>
              </div>
            )}
          </div>
          {error && <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          {phase === "unconfigured" && <div className="mt-3 rounded-xl bg-card p-4"><div className="mb-3 text-[13px] text-ink-secondary">Add a Box API key to give this bot a cloud computer. It spins up here automatically.</div><ApiKeyRow section="box" onSaved={(configured) => configured && setRetry((value) => value + 1)} /></div>}

          {phase === "ready" && control.helpReason && !control.held && (
            <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4"><div className="text-[13px] leading-relaxed text-warning"><b>{bot.name}</b> asked for your hands: {control.helpReason}</div><div className="mt-2 flex gap-2"><button onClick={() => void openDesktop()} disabled={controlPending || pending === "join"} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50">{pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}Take control</button><button onClick={() => controlAction("dismiss-help")} disabled={controlPending} className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">Dismiss</button></div></div>
          )}
          {phase === "ready" && control.held && (
            <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4"><div className="text-[13px] leading-relaxed text-ink">You have the wheel. The bot's clicks and keystrokes are refused until you hand it back. Use Open desktop to drive.</div><button onClick={() => { controlAction("release"); void window.ogb?.desktopViewer?.close(bot.id); }} disabled={controlPending} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"><Hand size={14} />Hand control back</button></div>
          )}
          {phase === "ready" && (
            <div className="mt-3 flex gap-2">
              {!control.held && !control.helpReason && <button onClick={() => void openDesktop()} disabled={controlPending || pending === "join"} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" title="Pause the bot's hands and drive this computer yourself">{pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}Take control</button>}
              {control.held && <button onClick={() => void openDesktop()} disabled={pending === "join"} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">{pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}Open live desktop</button>}
              {boxState !== "archived" && <button onClick={sleep} disabled={pending === "sleep"} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50" title="Put the computer to sleep">{pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}Sleep</button>}
            </div>
          )}

          <LocalScreenPreview />

          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Runs on</div><div className="mt-0.5 text-[13px] text-ink-secondary">Use a Box cloud computer for browser and desktop tasks, or turn computer access off.</div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([["cloud", "Box"], ["off", "Off"]] as const).map(([mode, label], index) => {
                const disabled = mode === "cloud" && !cloudSupported;
                const selected = (mode === "off") === (bot.computer === "off");
                return <button key={mode} disabled={disabled} title={disabled ? "This model engine cannot use cloud computer tools" : undefined} onClick={() => { if (selected) return; dispatch({ type: "updateBot", botId: bot.id, patch: mode === "cloud" ? { computer: "cloud", cloudBackend: "box" } : { computer: "off" } }); }} className={cn("flex-1 py-1.5 text-[13px]", index > 0 && "border-l border-hairline/40", disabled && "cursor-not-allowed opacity-40", selected ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink")}>{label}</button>;
              })}
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-[15px] font-medium text-ink"><CalendarClock size={16} className="text-accent" />Scheduled tasks</div>{botRoutines.length > 0 && <span className="rounded-full bg-control px-2 py-0.5 text-[10px] font-medium text-ink-secondary">{botRoutines.length}</span>}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">Schedule work for {bot.name}. Use its current setup, or run the whole job inside its cloud VM.</div>
            {bot.computer === "off" && <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning"><Power size={13} className="mt-0.5 shrink-0" />Scheduled tasks on this computer will not have desktop access while this is Off. Choose Cloud VM in the schedule editor to run the whole job there.</div>}
            {activeRoutineRun && <button onClick={() => dispatch({ type: "showRoutines" })} className="mt-3 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"><Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} /><span className="min-w-0 flex-1 truncate">{activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}</span></button>}
            {botRoutines.length > 0 && <div className="mt-3 space-y-1.5">{botRoutines.slice(0, 3).map((routine) => <button key={routine.id} onClick={() => dispatch({ type: "showRoutines" })} className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-control/60"><span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} /><span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span><span className="block truncate text-[10.5px] text-ink-secondary">{routineScheduleLabel(routine)}{routine.runOn === "cloud" ? " · runs on VM" : ""}</span></span><span className="shrink-0 text-[10px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span></button>)}</div>}
            <div className="mt-3 flex gap-2"><button onClick={() => setCreatingRoutine(true)} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110"><Plus size={14} />Create schedule</button><button onClick={() => dispatch({ type: "showRoutines" })} className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover" title="Open schedules"><CalendarDays size={14} />Schedules</button></div>
          </div>
        </div>
      )}
      {creatingRoutine && <RoutineEditor bots={[bot]} lockedBotId={bot.id} defaultRunOn={cloudRoutineReady ? "cloud" : "maus"} onClose={() => setCreatingRoutine(false)} />}
    </aside>
  );
}

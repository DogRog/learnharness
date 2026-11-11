"use client";
/**
 * Settings → General → iPad access (remote-access wave, 2026-11-11).
 * Managed only from the Mac window: the routes refuse paired devices, and
 * in a plain browser this shows one line instead of controls.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { CommitInput, SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

interface RemoteAccessStatus {
	enabled: boolean;
	port: number;
	keepAwake: boolean;
	listening: boolean;
	restartRequired: boolean;
	pairing: { expiresAt: number } | null;
	devices: { id: string; name: string; createdAt: string }[];
}

const noSubscribe = () => () => {};
function useDesktopWindow(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh), () => false);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	const response = await fetch(path, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `Request failed (${response.status}).`);
	}
	return response;
}

/** Anything that is not a status (an older server, a test double) shows no controls. */
function asStatus(value: unknown): RemoteAccessStatus | null {
	const v = value as Partial<RemoteAccessStatus> | null;
	return v && typeof v === "object" && typeof v.enabled === "boolean" && typeof v.port === "number" && Array.isArray(v.devices) ? v as RemoteAccessStatus : null;
}

function minutesLeft(expiresAt: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function RemoteAccessSettings() {
	const desktop = useDesktopWindow();
	const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const refresh = useCallback(async () => {
		try {
			setStatus(asStatus(await (await call("/api/remote-access")).json()));
			setError(null);
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	}, []);

	useEffect(() => { if (desktop) void refresh(); }, [desktop, refresh]);

	// While a code is showing, tick the countdown and notice when the iPad
	// has used it (the pairing disappears from the status).
	useEffect(() => {
		if (!code) return;
		const timer = setInterval(() => {
			setNow(Date.now());
			void refresh();
		}, 3000);
		return () => clearInterval(timer);
	}, [code, refresh]);
	useEffect(() => {
		if (code && status && (!status.pairing || code.expiresAt <= now)) setCode(null);
	}, [code, status, now]);

	const save = async (patch: Partial<Pick<RemoteAccessStatus, "enabled" | "port" | "keepAwake">>): Promise<boolean> => {
		try {
			setStatus(asStatus(await (await call("/api/remote-access", { method: "PUT", body: JSON.stringify(patch) })).json()));
			setError(null);
			if (patch.enabled === false) setCode(null);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		}
	};

	const pair = async () => {
		try {
			const created = await (await call("/api/remote-access/pairing", { method: "POST" })).json() as { code: string; expiresAt: number };
			// Fresh status first, so the "code was used" check below never
			// compares the new code against the status from before it existed.
			const fresh = asStatus(await (await call("/api/remote-access")).json());
			setStatus(fresh);
			setCode(created);
			setNow(Date.now());
			setError(null);
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	};

	const cancel = async () => {
		setCode(null);
		try { await call("/api/remote-access/pairing", { method: "DELETE" }); } catch { /* the code expires anyway */ }
		void refresh();
	};

	const revoke = async (id: string) => {
		try {
			await call(`/api/remote-access/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
			void refresh();
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	};

	if (!desktop) {
		return (
			<SettingsGroup label="iPad access" testid="group-remote-access">
				<p className="text-xs text-muted-foreground">Manage iPad access and paired devices in LearnHarness on your Mac.</p>
			</SettingsGroup>
		);
	}

	return (
		<SettingsGroup label="iPad access" testid="group-remote-access">
			{error && <p role="alert" className="text-xs text-error" data-testid="remote-access-error">{error}</p>}
			{status && (
				<>
					<SettingsRow
						label="Allow iPad access"
						hint="Use LearnHarness from your iPad over Tailscale. Paired devices get full access."
						testid="row-remote-access"
					>
						<Toggle checked={status.enabled} label="allow ipad access" onChange={(on) => void save({ enabled: on })} />
					</SettingsRow>
					<SettingsRow label="Port" hint="Tailscale forwards to this port on the Mac. Applies after reopening LearnHarness." dimmed={!status.enabled} testid="row-remote-access-port">
						<div className="w-24">
							<CommitInput
								type="number"
								min={1024}
								max={65535}
								step={1}
								value={String(status.port)}
								ariaLabel="iPad access port"
								testid="remote-access-port"
								disabled={!status.enabled}
								onCommit={(next) => {
									const port = Number(next);
									if (!Number.isInteger(port)) { setError("Port must be a whole number from 1024 to 65535."); return false; }
									return save({ port });
								}}
							/>
						</div>
					</SettingsRow>
					<SettingsRow label="Keep Mac awake" hint="Stops the Mac sleeping while iPad access is on. The display can still turn off." dimmed={!status.enabled} testid="row-remote-access-awake">
						<Toggle checked={status.keepAwake} disabled={!status.enabled} label="keep mac awake" onChange={(on) => void save({ keepAwake: on })} />
					</SettingsRow>
					{status.enabled && (
						<div className="flex flex-col gap-2 rounded-sm border border-border/60 p-3 text-xs text-muted-foreground" data-testid="remote-access-setup">
							{status.restartRequired ? (
								<p className="text-foreground" role="status">Quit and reopen LearnHarness to start serving on port {status.port}.</p>
							) : (
								<p className="text-foreground" role="status">Serving on 127.0.0.1:{status.port}.</p>
							)}
							<p>One-time setup in Terminal on this Mac, with Tailscale installed and signed in:</p>
							<code className="block select-all rounded-sm bg-accent px-2 py-1 font-ui text-foreground">tailscale serve --bg {status.port}</code>
							<p>On the iPad, sign in to Tailscale, open the https://….ts.net address that command prints, pair, then use Share → Add to Home Screen.</p>
						</div>
					)}
					{status.enabled && (
						<SettingsRow
							label="Pair a device"
							hint={code ? `Enter this code on the iPad. It expires in ${minutesLeft(code.expiresAt, now)}.` : "Shows a one-time code to enter on the iPad."}
							testid="row-remote-access-pair"
						>
							{code ? (
								<span className="flex items-center gap-3">
									<span className="font-ui text-2xl tracking-[0.3em] text-foreground" data-testid="remote-access-code">{code.code}</span>
									<Button type="button" size="xs" variant="outline" className="cursor-pointer" onClick={() => void cancel()}>Cancel</Button>
								</span>
							) : (
								<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="remote-access-pair" onClick={() => void pair()}>Pair a device</Button>
							)}
						</SettingsRow>
					)}
					{status.devices.map((device) => (
						<SettingsRow
							key={device.id}
							label={device.name}
							hint={`Paired ${new Date(device.createdAt).toLocaleDateString()}`}
							testid="row-remote-access-device"
						>
							<Button type="button" size="xs" variant="outline" className="cursor-pointer" onClick={() => void revoke(device.id)}>Revoke</Button>
						</SettingsRow>
					))}
				</>
			)}
		</SettingsGroup>
	);
}

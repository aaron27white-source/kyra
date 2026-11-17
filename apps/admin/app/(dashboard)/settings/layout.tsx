import { isPilotMode } from "@lobbystack/shared";
import { SettingsShell } from "@/components/settings-shell";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell pilotMode={isPilotMode(process.env)}>{children}</SettingsShell>;
}

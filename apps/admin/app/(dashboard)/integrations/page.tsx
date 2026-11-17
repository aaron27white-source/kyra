import { LiveIntegrationsSurface } from "@/components/live-integrations-surface";
import { isPilotMode } from "@lobbystack/shared";

export default function IntegrationsPage() {
  return <LiveIntegrationsSurface showWebhooks={!isPilotMode(process.env)} />;
}

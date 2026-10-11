import { loadCameras, loadCoordsSource } from "@/src/lib/store";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Dashboard cameras={loadCameras()} coordsSource={loadCoordsSource()} />;
}

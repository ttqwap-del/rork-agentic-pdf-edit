import { createRoot } from "react-dom/client";

import PrivateStudio, { StudioErrorBoundary } from "./PrivateStudio.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StudioErrorBoundary><PrivateStudio /></StudioErrorBoundary>);

import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Auth from "./pages/Auth";
import Landing from "./pages/Landing";
import OAuthConsent from "./pages/OAuthConsent";
import Overview from "./pages/Overview";
import Plan from "./pages/Plan";
import Track from "./pages/Track";
import Verify from "./pages/Verify";
import Org from "./pages/Org";
import { isTokenExpired, signOut } from "@/lib/auth";
import { canAccess, useMe } from "@/hooks/use-me";
import type { Role } from "../../db/schema";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (isTokenExpired()) {
    if (localStorage.getItem("token")) signOut(false);
    return <Navigate to="/auth" replace />;
  }
  return <>{children}</>;
}

function RequireRole({ min, children }: { min: Role; children: React.ReactNode }) {
  const { role, home, isLoading } = useMe();
  if (isLoading) return null;
  if (!canAccess(role, min)) return <Navigate to={home} replace />;
  return <>{children}</>;
}

function Home() {
  const { home, isLoading } = useMe();
  if (isLoading) return null;
  return <Navigate to={home} replace />;
}

/** `/` is the public page for a visitor and the role-based redirect for a member. */
function Root() {
  if (isTokenExpired()) {
    if (localStorage.getItem("token")) signOut(false);
    return <Landing />;
  }
  return <Home />;
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        <Route path="/" element={<Root />} />
        <Route path="/welcome" element={<Landing />} />
        {/* Public and outside the shell: whoever is checking an invoice has no
            account here, and a verification page is not a place to sell them one. */}
        <Route path="/verify/:token" element={<Verify />} />
        <Route element={<Layout />}>
          <Route path="/overview/*" element={<ProtectedRoute><RequireRole min="manager"><Overview /></RequireRole></ProtectedRoute>} />
          <Route path="/plan/*" element={<ProtectedRoute><RequireRole min="manager"><Plan /></RequireRole></ProtectedRoute>} />
          <Route path="/track/*" element={<ProtectedRoute><Track /></ProtectedRoute>} />
          <Route path="/org/*" element={<ProtectedRoute><RequireRole min="admin"><Org /></RequireRole></ProtectedRoute>} />
          <Route path="*" element={<ProtectedRoute><Home /></ProtectedRoute>} />
        </Route>
      </Routes>
    </Router>
  );
}

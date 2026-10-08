import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { ROUTES } from "../lib/routes";
import { Icon } from "../components/shared/Icon";

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <Icon name="video" size={64} className="mb-4" style={{ color: "var(--brand-500)" }} />
      <h2 className="text-[var(--fs-2xl)] font-bold text-[var(--ink-900)] mb-2">
        页面未找到
      </h2>
      <p className="text-[var(--fs-sm)] text-[var(--ink-500)] mb-6 max-w-sm">
        你要找的页面不存在或已被移除。
      </p>
      <Button variant="primary" onClick={() => navigate(ROUTES.studio)}>
        回到首页
      </Button>
    </div>
  );
}

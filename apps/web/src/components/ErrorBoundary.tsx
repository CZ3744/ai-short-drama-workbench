import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

// 2026-07-09 audit(text-global finding P3 · ErrorBoundary): 页面崩溃时不再默认把原始
// JS 异常(几乎都是英文, 如 "Cannot read properties of undefined")铺在正文吓用户 (铁律 #9
// toC 兜底)。正文只讲人话, 原始 error.message / componentStack 收进默认折叠的
// "查看技术详情", 本机排障时展开即可。
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, showDetails: false });
  };

  componentDidUpdate(previous: Props) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) this.handleReset();
  }

  handleGoHome = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, showDetails: false });
    window.location.href = "/";
  };

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const technicalDetail = [
        this.state.error?.message,
        this.state.error?.stack,
        this.state.errorInfo?.componentStack
          ? `组件堆栈:${this.state.errorInfo.componentStack}`
          : "",
      ].filter(Boolean).join("\n\n");

      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
          <div className="mb-4 text-[var(--err)]">
            <svg className="h-16 w-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
            </svg>
          </div>
          <h2 className="text-[var(--fs-xl)] font-semibold text-[var(--ink-900)] mb-2">
            页面出了点问题
          </h2>
          <p className="text-[var(--fs-sm)] text-[var(--ink-500)] mb-4 max-w-md">
            刷新页面或回到首页通常能解决。如果反复出现，可以展开下方技术详情辅助排查。
          </p>

          {technicalDetail && (
            <div className="mb-6 w-full max-w-md text-left">
              <button
                type="button"
                onClick={this.toggleDetails}
                className="text-[var(--fs-xs)] text-[var(--ink-400)] underline underline-offset-2 hover:text-[var(--ink-600)]"
              >
                {this.state.showDetails ? "收起技术详情" : "查看技术详情"}
              </button>
              {this.state.showDetails && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--ink-100)] bg-[var(--ink-50)] p-3 text-[11px] leading-relaxed text-[var(--ink-500)]">
                  {technicalDetail}
                </pre>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              重试
            </Button>
            <Button variant="primary" size="sm" onClick={this.handleGoHome}>
              回到首页
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

import * as React from "react";
import * as ReactDOM from "react-dom/client";

function showError(error: unknown) {
  const root = document.getElementById("root")!;
  root.textContent = error instanceof Error ? error.message : String(error);
  root.setAttribute("role", "alert");
  root.style.cssText = "white-space:pre-wrap;color:#b91c1c;padding:20px;font:14px system-ui";
}

export function render(code: string) {
  try {
    const module = { exports: {} as Record<string, any> };
    const require = (name: string) => {
      if (name === "react") return React;
      if (name === "react-dom/client") return ReactDOM;
      throw new Error(`미리보기에서 지원하지 않는 모듈: ${name}. react와 react-dom/client를 사용할 수 있습니다.`);
    };
    const evaluate = new Function("require", "module", "exports", "React", "ReactDOM", code + '\nreturn module.exports.default || (typeof App !== "undefined" ? App : undefined);');
    const Component = evaluate(require, module, module.exports, React, ReactDOM);
    if (!Component) throw new Error("기본 내보내기(export default) 또는 App 컴포넌트가 필요합니다.");
    ReactDOM.createRoot(document.getElementById("root")!, { onUncaughtError: showError }).render(React.createElement(Component));
  } catch (error) { showError(error); }
}

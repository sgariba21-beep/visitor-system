export default function Spinner({ size = 24, color = "#2563eb" }) {
  return (
    <div style={{
      width: size, height: size,
      border: `3px solid #e5e7eb`,
      borderTop: `3px solid ${color}`,
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
      display: "inline-block"
    }} />
  );
}

// Inject the keyframe globally once
const style = document.createElement("style");
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
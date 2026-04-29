import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return (
    <div style={{ padding: 40 }}>
      <h1>CONTROL HORARIO</h1>
      <p style={{ color: "green", fontWeight: "bold" }}>
        VERSION LEGAL OK
      </p>
      <p><strong>Empresa:</strong> Letras a la Taza</p>
      <p><strong>CIF:</strong> B71209530</p>
      <p><strong>Centro:</strong> Tudela</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

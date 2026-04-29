import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

const APP_VERSION = "LEGAL-OK-FINAL";

function App() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  function generarPDF() {
    const contenido = `
      <h1>Control horario</h1>
      <p><strong>Empresa:</strong> Letras a la Taza</p>
      <p><strong>CIF:</strong> B71209530</p>
      <p><strong>Centro:</strong> Tudela</p>

      <h3>Declaración legal</h3>
      <p>
        El presente informe recoge el registro diario de jornada conforme al artículo 34.9 del Estatuto de los Trabajadores.
      </p>
      <p>
        La empresa conservará estos registros durante el periodo legal exigible, estando disponibles para Inspección de Trabajo.
      </p>

      <h3>Firma</h3>
      <p>Empresa _______________________</p>
      <p>Trabajador ____________________</p>
    `;

    const ventana = window.open("", "_blank");
    ventana.document.write(contenido);
    ventana.document.close();
    ventana.print();
  }

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Control horario y fichaje</h1>

      <p style={{ color: "green", fontWeight: "bold" }}>
        Versión: {APP_VERSION}
      </p>

      <p>{now.toLocaleString()}</p>

      <hr />

      <p><strong>Empresa:</strong> Letras a la Taza</p>
      <p><strong>CIF:</strong> B71209530</p>
      <p><strong>Centro:</strong> Tudela</p>

      <button onClick={generarPDF} style={{ marginTop: 20 }}>
        Generar informe (test legal)
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

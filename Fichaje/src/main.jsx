import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

const APP_VERSION = "LEGAL-INSPECCION-V1";

function App() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  function generarInforme() {
    const fecha = new Date().toLocaleString();

    const html = `
      <html>
      <head>
        <title>Informe control horario</title>
        <style>
          body { font-family: Arial; padding: 30px; }
          h1 { margin-bottom: 10px; }
          h3 { margin-top: 25px; }
          .box { margin-top: 10px; }
          .legal {
            margin-top: 20px;
            padding: 12px;
            border: 1px solid #ccc;
            background: #f9fafb;
            border-radius: 10px;
          }
          .firma {
            margin-top: 40px;
            display: flex;
            justify-content: space-between;
          }
        </style>
      </head>
      <body>

        <h1>Informe de control horario</h1>

        <div class="box">
          <strong>Empresa:</strong> Letras a la Taza<br/>
          <strong>CIF:</strong> B71209530<br/>
          <strong>Centro de trabajo:</strong> Tudela<br/>
          <strong>Generado:</strong> ${fecha}
        </div>

        <h3>Resumen</h3>
        <p>Informe de prueba con base legal.</p>

        <div class="legal">
          <h3>Declaración legal</h3>
          <p>
            El presente informe recoge el registro diario de jornada conforme al artículo 34.9 del Estatuto de los Trabajadores (Real Decreto-ley 8/2019).
          </p>
          <p>
            La empresa conservará estos registros durante un periodo mínimo de cuatro años, quedando a disposición del trabajador, sus representantes legales y la Inspección de Trabajo.
          </p>
          <p>
            Los registros no pueden ser modificados ni eliminados. Cualquier corrección deberá quedar registrada como ajuste manual trazable.
          </p>
        </div>

        <div class="firma">
          <div>
            Firma empresa<br/>
            Nombre y DNI
          </div>
          <div>
            Firma trabajador<br/>
            Nombre y DNI
          </div>
        </div>

      </body>
      </html>
    `;

    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
    win.print();
  }

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Control horario</h1>

      <p style={{ color: "green", fontWeight: "bold" }}>
        Versión: {APP_VERSION}
      </p>

      <p>{now.toLocaleString()}</p>

      <hr />

      <p><strong>Empresa:</strong> Letras a la Taza</p>
      <p><strong>CIF:</strong> B71209530</p>
      <p><strong>Centro:</strong> Tudela</p>

      <button
        onClick={generarInforme}
        style={{
          marginTop: 20,
          padding: 10,
          background: "#111",
          color: "white",
          borderRadius: 8
        }}
      >
        Generar informe legal
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

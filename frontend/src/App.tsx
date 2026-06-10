import { useState } from "react";

function App() {
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");

  async function sendMessage() {
    const res = await fetch("http://localhost:5000/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    setReply(data.reply);
  }

  return (
    <div style={{ padding: "20px", fontFamily: "Arial" }}>
      <h1>Kapruka AI Agent</h1>
      <div style={{ marginBottom: "10px" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask me something..."
          style={{ width: "300px", padding: "8px" }}
        />
        <button onClick={sendMessage} style={{ marginLeft: "10px", padding: "8px" }}>
          Send
        </button>
      </div>
      <div>
        <strong>Agent Reply:</strong>
        <p>{reply}</p>
      </div>
    </div>
  );
}

export default App;

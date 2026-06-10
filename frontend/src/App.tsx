import { useState } from "react";
function App() {
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");

  const sendQuery = async () => {
    if (!query.trim()) return;
    try {
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}${process.env.REACT_APP_MCP_ENDPOINT}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        }
      );
      const data = await res.json();
      setReply(data.reply);
    } catch (err) {
      setReply("Error: Could not connect to backend.");
    }
  };

  return (
    <div className="App">
      <h2>🛒 Kapruka AI Shopping Agent</h2>
      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask me about products, categories, delivery..."
          style={{ width: "60%", padding: "8px" }}
        />
        <button onClick={sendQuery} style={{ marginLeft: "10px" }}>
          Send
        </button>
      </div>
      <div style={{ marginTop: "20px", whiteSpace: "pre-wrap" }}>
        <strong>Agent:</strong>
        <div>{reply}</div>
      </div>
    </div>
  );
}

export default App;

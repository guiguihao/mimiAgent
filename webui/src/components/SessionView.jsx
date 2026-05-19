import { useState, useEffect, useRef } from 'react'
import { Send, User, Bot, Plus } from 'lucide-react'
import './SessionView.css'

export default function SessionView() {
  const [sessionId] = useState(() => {
    const savedId = localStorage.getItem('webui_session_id');
    if (savedId) return savedId;
    const newId = 'webui_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('webui_session_id', newId);
    return newId;
  });

  const [messages, setMessages] = useState([
    { id: 1, role: 'system', content: 'Agent initialized and ready. Please type a message to interact.' }
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    // 加载独立的 WebUI 历史会话
    fetch(`/api/chat/history?sessionId=${sessionId}`)
      .then(res => res.json())
      .then(data => {
        if (data.history && data.history.length > 0) {
          setMessages(data.history)
        }
      })
      .catch(err => console.error('Failed to load chat history:', err))
  }, [sessionId])

  const handleSend = async () => {
    if (!input.trim()) return
    
    const userMessage = input.trim()
    const newMsg = { id: Date.now(), role: 'user', content: userMessage }
    setMessages(prev => [...prev, newMsg])
    setInput('')
    setIsTyping(true)
    
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, sessionId })
      })
      
      const data = await response.json()
      
      setMessages(prev => [...prev, { 
        id: Date.now(), 
        role: 'assistant', 
        content: data.reply || 'Agent did not return a response.'
      }])
    } catch (err) {
      setMessages(prev => [...prev, { 
        id: Date.now(), 
        role: 'assistant', 
        content: `Error: ${err.message}` 
      }])
    } finally {
      setIsTyping(false)
    }
  }

  const handleNewSession = async () => {
    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '/new', sessionId })
      })
      setMessages([{ id: Date.now(), role: 'system', content: 'Session restarted.' }])
    } catch(err) {
      console.error(err)
    }
  }

  return (
    <div className="session-view fade-in">
      <header className="view-header flex-between">
        <div>
          <h1 className="view-title">Active Session</h1>
          <p className="view-subtitle">Monitor and interact with the agent in real-time (Session: {sessionId})</p>
        </div>
        <button className="btn btn-outline" onClick={handleNewSession}>
          <Plus size={16} /> New Session
        </button>
      </header>

      <div className="chat-container glass-panel">
        <div className="messages-list">
          {messages.map(msg => (
            <div key={msg.id} className={`message-wrapper ${msg.role}`}>
              <div className="message-avatar">
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="message-bubble" style={{ whiteSpace: 'pre-wrap' }}>
                {msg.content}
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="message-wrapper assistant">
              <div className="message-avatar"><Bot size={16} /></div>
              <div className="message-bubble typing-indicator">
                <span>.</span><span>.</span><span>.</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        <div className="chat-input-area">
          <input 
            type="text" 
            className="chat-input"
            placeholder="Type a command or message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            disabled={isTyping}
          />
          <button className="btn-send" onClick={handleSend} disabled={isTyping}>
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

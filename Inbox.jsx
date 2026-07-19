import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useOutletContext } from 'react-router-dom';

function Inbox() {
  const { selectedPageId, authToken, backendUrl } = useOutletContext();

  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState({ conversations: false, messages: false });
  const [error, setError] = useState('');

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Fetch conversations when selectedPageId changes
  useEffect(() => {
    if (!selectedPageId) {
      setConversations([]);
      setSelectedConversation(null);
      setMessages([]);
      return;
    }

    const fetchConversations = async () => {
      setLoading(prev => ({ ...prev, conversations: true }));
      setError('');
      try {
        const response = await axios.get(`${backendUrl}/api/inbox/conversations/${selectedPageId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        setConversations(response.data);
      } catch (err) {
        setError('Failed to load conversations.');
        console.error(err);
      } finally {
        setLoading(prev => ({ ...prev, conversations: false }));
      }
    };

    fetchConversations();
  }, [selectedPageId, authToken, backendUrl]);

  // Fetch messages when a conversation is selected
  useEffect(() => {
    if (!selectedConversation) {
      setMessages([]);
      return;
    }

    const fetchMessages = async () => {
      setLoading(prev => ({ ...prev, messages: true }));
      try {
        const response = await axios.get(`${backendUrl}/api/inbox/messages/${selectedPageId}/${selectedConversation.psid}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        setMessages(response.data);
      } catch (err) {
        setError('Failed to load messages.');
        console.error(err);
      } finally {
        setLoading(prev => ({ ...prev, messages: false }));
      }
    };

    fetchMessages();
  }, [selectedConversation, selectedPageId, authToken, backendUrl]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation) return;

    try {
      const response = await axios.post(`${backendUrl}/api/inbox/reply`, {
        pageId: selectedPageId,
        psid: selectedConversation.psid,
        message: newMessage,
      }, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      setMessages(prev => [...prev, response.data]);
      setNewMessage('');
    } catch (err) {
      setError('Failed to send message.');
      console.error(err);
    }
  };

  return (
    <div className="flex h-[calc(100vh-80px)]">
      {/* Conversations Sidebar */}
      <div className="w-1/4 border-r border-gray-200 overflow-y-auto">
        <h2 className="text-lg font-semibold p-4 border-b">Conversations</h2>
        {loading.conversations ? (
          <p className="p-4 text-gray-500">Loading...</p>
        ) : (
          <ul>
            {conversations.map(convo => (
              <li
                key={convo.psid}
                className={`p-4 cursor-pointer hover:bg-gray-100 ${selectedConversation?.psid === convo.psid ? 'bg-blue-100' : ''}`}
                onClick={() => setSelectedConversation(convo)}
              >
                <p className="font-bold">{convo.userName || 'Unknown User'}</p>
                <p className="text-sm text-gray-600 truncate">{convo.lastMessage}</p>
                <p className="text-xs text-gray-400 text-right">{new Date(convo.lastMessageTimestamp).toLocaleTimeString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Message Panel */}
      <div className="w-3/4 flex flex-col">
        {selectedConversation ? (
          <>
            <div className="p-4 border-b border-gray-200">
              <h3 className="font-bold text-xl">{selectedConversation.userName || 'Unknown User'}</h3>
            </div>
            <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
              {loading.messages ? (
                <p>Loading messages...</p>
              ) : (
                messages.map(msg => (
                  <div
                    key={msg._id}
                    className={`flex mb-4 ${msg.sender === 'page' || msg.sender === 'bot' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-lg p-3 rounded-lg ${
                        msg.sender === 'page' || msg.sender === 'bot'
                          ? 'bg-blue-500 text-white'
                          : 'bg-white border'
                      }`}
                    >
                      <p>{msg.message.text}</p>
                      <p className={`text-xs mt-1 ${
                        msg.sender === 'page' || msg.sender === 'bot'
                          ? 'text-blue-200'
                          : 'text-gray-400'
                      }`}>
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            <div className="p-4 border-t bg-white">
              <form onSubmit={handleSendMessage} className="flex">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type your message..."
                  className="flex-1 p-2 border rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  className="bg-blue-500 text-white px-4 py-2 rounded-r-md hover:bg-blue-600"
                >
                  Send
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <p>Select a conversation to start chatting.</p>
          </div>
        )}
        {error && <p className="text-red-500 p-2">{error}</p>}
      </div>
    </div>
  );
}

export default Inbox;
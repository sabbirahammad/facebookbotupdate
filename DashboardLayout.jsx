import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useLocation, useNavigate, Outlet, NavLink } from 'react-router-dom';

function DashboardLayout() {
  const [pages, setPages] = useState([]);
  const [selectedPageId, setSelectedPageId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const location = useLocation();
  const navigate = useNavigate();
  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tokenFromUrl = params.get('token');
    let currentAuthToken = localStorage.getItem('authToken');

    if (tokenFromUrl) {
      localStorage.setItem('authToken', tokenFromUrl);
      currentAuthToken = tokenFromUrl;
      // URL থেকে টোকেনটি সরিয়ে ফেলুন, কিন্তু পেজ রিলোড করবেন না
      navigate('/dashboard', { replace: true });
    }

    if (!currentAuthToken) {
      // যদি কোনো টোকেন না থাকে, তাহলে লগইন পেজে ফেরত পাঠান
      navigate('/'); 
      return;
    }

    // এখন নিশ্চিতভাবে টোকেন আছে, তাই ব্যবহারকারীর ডেটা আনুন
    axios.get(`${backendUrl}/api/dashboard/me`, {
      headers: { 'Authorization': `Bearer ${currentAuthToken}` }
    }).then(meResponse => {
      const userPages = meResponse.data.pages;
      if (!userPages || userPages.length === 0) {
        setError("You don't manage any pages. Please connect a page.");
        return;
      }
      setPages(userPages);
      // Check if there's a saved page ID, otherwise use the first one
      const savedPageId = localStorage.getItem('selectedPageId');
      if (savedPageId && userPages.some(p => p.pageId === savedPageId)) {
        setSelectedPageId(savedPageId);
      } else {
        setSelectedPageId(userPages[0].pageId);
      }
    }).catch(err => {
      console.error("Error fetching user data:", err);
      setError("Failed to load user data. Your session might have expired.");
    }).finally(() => {
      setLoading(false);
    });
  }, [navigate, location, backendUrl]);

  useEffect(() => {
    if (selectedPageId) {
      localStorage.setItem('selectedPageId', selectedPageId);
    }
  }, [selectedPageId]);

  if (loading) return <p>Loading user data...</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-64 bg-white shadow-md">
        <div className="p-4">
          <h2 className="text-xl font-bold">My Bot</h2>
        </div>
        <nav className="mt-5">
          <NavLink to="/dashboard" end className={({ isActive }) => `block py-2.5 px-4 rounded transition duration-200 ${isActive ? 'bg-blue-500 text-white' : 'hover:bg-gray-200'}`}>Dashboard</NavLink>
          <NavLink to="/dashboard/orders" className={({ isActive }) => `block py-2.5 px-4 rounded transition duration-200 ${isActive ? 'bg-blue-500 text-white' : 'hover:bg-gray-200'}`}>Orders</NavLink>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex justify-end items-center p-4 bg-white border-b">
          <select
            value={selectedPageId}
            onChange={(e) => setSelectedPageId(e.target.value)}
            className="p-2 border rounded"
            disabled={pages.length === 0}
          >
            {pages.length > 0 ? pages.map(page => (
              <option key={page.pageId} value={page.pageId}>{page.name}</option>
            )) : <option>No pages found</option>}
          </select>
        </header>
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-gray-100 p-4">
          {/* Pass context to child routes */}
          <Outlet context={{ selectedPageId, authToken: localStorage.getItem('authToken'), backendUrl }} />
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
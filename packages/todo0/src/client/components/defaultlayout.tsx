import { Sidebar } from 'flowbite-react';
import { useState } from 'react';
import { HiHome, HiLogout, HiUserCircle } from 'react-icons/hi';
import { Outlet, useNavigate } from 'react-router-dom';
import todoListIcon from '../assets/todo_list_icon.png';
import { useAuthState } from './authState';
import ConfirmModal from './ConfirmModal';

function DefaultLayout() {
  const { authState, onRevokeAuthFn } = useAuthState();
  const navigate = useNavigate();
  const [showConfirm, setShowConfirm] = useState(false);

  const handleLogoutClick = () => setShowConfirm(true);
  const handleCancel = () => setShowConfirm(false);
  const handleConfirm = async () => {
    handleCancel();
    if (authState.isAuthenticated) {
      await onRevokeAuthFn();
    }
    navigate('/signin');
  };

  return (
    <div>
      <Sidebar className="fixed top-0 left-0 z-40 w-60 h-screen transition-transform -translate-x-full bg-white border-r border-gray-200 md:translate-x-0 dark:bg-gray-800 dark:border-gray-700 py-6 px-2">
        <Sidebar.Logo
          href="/"
          img={todoListIcon}
          imgAlt="Todo0"
          className="font-bold text-2xl text-teal-600 mb-6"
        >
          Todo0
        </Sidebar.Logo>
        <Sidebar.Items>
          <Sidebar.ItemGroup>
            <Sidebar.Item
              href="/"
              icon={HiHome}
              className={
                window.location.pathname === '/' ? 'bg-teal-100 text-teal-700 font-semibold' : ''
              }
            >
              Home
            </Sidebar.Item>
            <Sidebar.Item
              href="/profile"
              icon={HiUserCircle}
              className={
                window.location.pathname.startsWith('/profile')
                  ? 'bg-teal-100 text-teal-700 font-semibold'
                  : ''
              }
            >
              Profile
            </Sidebar.Item>
            <Sidebar.Item onClick={handleLogoutClick} icon={HiLogout} className="hover:bg-red-100">
              Logout
            </Sidebar.Item>
          </Sidebar.ItemGroup>
        </Sidebar.Items>
      </Sidebar>
      <main className="ml-24 w-full h-auto">
        <Outlet />
      </main>
      <ConfirmModal
        open={showConfirm}
        title="Confirm Logout"
        message="Are you sure you want to logout?"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}

export default DefaultLayout;

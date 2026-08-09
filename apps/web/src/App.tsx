import { useAuth } from './auth/AuthContext';
import { LoginPage } from './components/LoginPage';
import { BookingPage } from './components/BookingPage';

export function App() {
  const { status } = useAuth();

  if (status === 'checking') {
    return (
      <div className="center-note">
        <div className="spinner" aria-hidden="true" />
        <p className="eyebrow">Opening the box office</p>
      </div>
    );
  }

  return status === 'signed-in' ? <BookingPage /> : <LoginPage />;
}

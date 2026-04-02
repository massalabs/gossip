import { secureStorageEnabled } from '../../config/features';
import { SecureLogin } from './SecureLogin';
import { ClassicLogin } from './ClassicLogin';

const Login = secureStorageEnabled ? SecureLogin : ClassicLogin;

export default Login;

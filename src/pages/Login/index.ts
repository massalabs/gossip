import { SECURE_STORAGE_ENABLED } from '../../config/features';
import { SecureLogin } from './SecureLogin';
import { ClassicLogin } from './ClassicLogin';

const Login = SECURE_STORAGE_ENABLED ? SecureLogin : ClassicLogin;

export default Login;

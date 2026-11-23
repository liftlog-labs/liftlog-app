// Do not let EXPO_PUBLIC_USE_RN_FETCH opt credentialed calls into RN's legacy redirect behavior.
export { fetch as appFetch } from 'expo/fetch';

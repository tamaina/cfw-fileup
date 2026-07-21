export const MAX_ID_LENGTH = 64;
export const MAX_BUCKET_NAME_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 32;
export const MAX_FILE_PATH_LENGTH = 1024;
export const MAX_DIRECTORY_NAME_LENGTH = 255;
export const MAX_MIME_TYPE_LENGTH = 255;
export const MAX_PASSPHRASE_LENGTH = 1024;
export const MAX_TURNSTILE_TOKEN_LENGTH = 4096;
export const MAX_WEBAUTHN_FIELD_LENGTH = 16384;
export const MAX_APP_SETTING_TEXT_LENGTH = 10000;
export const MAX_DELETE_TARGETS = 100;
export const MAX_ARCHIVE_INDEX_ENTRIES = 10000;

/**
 * Custom multicodec code for AES-256 encryption keys.
 */
export const ENCRYPTION_KEY_MULTICODEC = 0xa2;

/** URL fragment key prefix for encrypted file links, e.g. #key=z... */
export const ENCRYPTION_URL_FRAGMENT_KEY = 'key';

/** URL fragment key for access tokens, e.g. #token=xxx */
export const TOKEN_URL_FRAGMENT_KEY = 'token';

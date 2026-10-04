package cz.m5cet.app.telecom;

import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccountHandle;

/**
 * 6.8: the service behind the app's self-managed calling account
 * (CallLogBridge.account). Telecom wants one for every account; the account
 * exists only so that a phone app can name the app of its call log entries.
 * The rooms' calls are WebRTC and never go through Telecom, so every
 * connection Telecom might ask for is refused — nothing is dialed or
 * answered here.
 */
public final class M5ConnectionService extends ConnectionService {
    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        return Connection.createFailedConnection(new DisconnectCause(DisconnectCause.ERROR, "M5cet calls do not go through the phone"));
    }

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        return Connection.createFailedConnection(new DisconnectCause(DisconnectCause.ERROR, "M5cet calls do not go through the phone"));
    }
}

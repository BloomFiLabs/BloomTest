from hyperliquid.utils.signing import sign_l1_action, action_hash
from eth_account import Account

wallet = Account.from_key('0x' + '1' * 64)
action = {
    'type': 'order',
    'orders': [{
        'a': 0,
        'b': True,
        'p': '100',
        's': '0.1',
        'r': False,
        't': {'limit': {'tif': 'Gtc'}}
    }],
    'grouping': 'na'
}

# Test with None
try:
    result1 = sign_l1_action(wallet, action, None, 1000, 2000, True)
    print('✅ None works')
    print(f'   Hash with None: {action_hash(action, None, 1000, 2000).hex()[:20]}...')
except Exception as e:
    print(f'❌ None failed: {e}')

# Test with empty string
try:
    result2 = sign_l1_action(wallet, action, '', 1000, 2000, True)
    print('✅ Empty string works')
    print(f'   Hash with "": {action_hash(action, "", 1000, 2000).hex()[:20]}...')
except Exception as e:
    print(f'❌ Empty string failed: {e}')


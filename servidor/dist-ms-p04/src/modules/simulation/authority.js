import { AppError } from '../../shared/errors.js';
import { exchangeAuthority } from '../exchange/authority.js';
import { hash } from './codec.js';
export async function authority(identity, context, params, s, consolidated = false) {
    const auth = await exchangeAuthority(identity, context, params, s, { consolidated });
    if (auth.actor.suspended || auth.actor.state !== 'ACTIVE' || auth.scope.kind === 'BUSINESS' && !auth.business?.isT)
        throw new AppError(403, 'ACCESS_DENIED');
    const key = hash([auth.actor._id, consolidated ? 'CONSOLIDATED' : auth.scope.kind, auth.scope.bookId, auth.scope.ownerId]);
    return { scope: auth.scope, actorId: auth.actor._id, context: auth.context, binding: hash(['S12', auth.binding, consolidated]), consolidated, key };
}
//# sourceMappingURL=authority.js.map
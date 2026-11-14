import * as nest from "nest";

@Injectable()
export class LoggingInterceptor {
    intercept(c: Ptr<nest.Ctx>, next: nest.Next): [Any, Error | null] {
        const [res, err] = next(c);
        console.log(`[users] ${c.method} ${c.path} took ${c.Elapsed()}`);
        if (err !== null) return [null!, err];
        return [res, null];
    }
}

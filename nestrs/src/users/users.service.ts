import * as nest from "nest";
import { User, CreateUserDto, UpdateUserDto } from "./dto/users.dto";

@Injectable()
export class UsersService {
    private users: Mutex<User[]> = new Mutex<User[]>([]);
    private nextId: Mutex<Int32> = new Mutex<Int32>(Int32(3));

    constructor() {
        this.users = new Mutex<User[]>([
            { id: 1 as Int32, name: "Alice", email: "alice@example.com" },
            { id: 2 as Int32, name: "Bob", email: "bob@example.com" },
        ]);
    }

    findAll(): User[] {
        return this.users.lock().clone();
    }

    findOne(id: Int32): [User, Error | null] {
        for (const u of this.findAll()) {
            if (u.id === id) return [u, null];
        }
        return [null!, nest.NotFoundException(`user ${id} not found`)];
    }

    create(dto: CreateUserDto): User {
        let users = this.users.lock();
        let id = this.nextId.lock();
        const u: User = { id: id.get(), name: dto.name, email: dto.email };
        users.push(u.clone());
        id.set(Int32(id.get() + 1));
        return u;
    }

    update(id: Int32, dto: UpdateUserDto): [User, Error | null] {
        let users = this.users.lock();
        for (const u of users.iterMut()) {
            if (u.id === id) {
                if (dto.name !== "") u.name = dto.name.clone();
                if (dto.email !== "") u.email = dto.email.clone();
                return [u.clone(), null];
            }
        }
        return [null!, nest.NotFoundException(`user ${id} not found`)];
    }

    remove(id: Int32): [Any, Error | null] {
        let users = this.users.lock();
        let i: Int32 = 0 as Int32;
        let found: Int32 = (-1) as Int32;
        for (const u of users.iter()) {
            if (u.id === id) { found = i; break; }
            i = (i + 1) as Int32;
        }
        if (found < 0) return [null, nest.NotFoundException(`user ${id} not found`)];
        users.remove(Usize(found));
        return [null, null];
    }
}
